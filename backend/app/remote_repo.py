"""Remote Model Repository, User Access Control (ACL), Check-Out Locking, Force Release & 3-Way Auto-Reapply Engine."""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import re
from typing import Any, Dict, List, Optional, Tuple
import uuid

from fastapi import HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .auth.dependencies import validate_steward_restrictions
from .auth.models import (
    AuditLogRecord,
    ModelRevisionRecord,
    RemoteCheckoutSessionRecord,
    RemoteModelAccessRecord,
    RemoteModelRecord,
    UserProfile,
    UserRecord,
    UserRole,
)
from .compilers.dbt_generator import write_dbt_artifacts_to_disk
from .config import settings
from .metamodel.domains import apply_all_domains
from .metamodel.schema import ColumnModel, EntityModel, ProjectMetamodel, RelationshipModel
from .metamodel.seed import ensure_seed_workspace, save_workspace_model


DEFAULT_REMOTE_MODEL_ID = "model-enterprise-insurance"


# ---------------------------------------------------------------------------
# Pydantic DTOs for Remote Repository & Access Control
# ---------------------------------------------------------------------------
class ModelAccessEntry(BaseModel):
    user_email: str
    full_name: str = ""
    user_role: str = ""
    permission: str = "VIEW"  # NONE, VIEW, EDIT, ADMIN


class RevokedSessionSummary(BaseModel):
    checkout_id: str
    base_version: int
    force_released_by_email: Optional[str] = None
    force_released_reason: Optional[str] = None
    force_released_at: Optional[str] = None
    has_saved_draft: bool = False


class RemoteModelSummary(BaseModel):
    id: str
    name: str
    description: str
    current_version: int
    version_tag: str
    entity_count: int
    relationship_count: int
    created_by_email: str
    is_locked: bool
    checked_out_by_email: Optional[str] = None
    checked_out_by_name: Optional[str] = None
    checked_out_at: Optional[str] = None
    checkout_id: Optional[str] = None
    updated_at: str
    user_permission: str = "VIEW"  # NONE, VIEW, EDIT, ADMIN
    revoked_session: Optional[RevokedSessionSummary] = None


class RemoteModelDetailResponse(BaseModel):
    summary: RemoteModelSummary
    project: ProjectMetamodel
    work_mode: str  # "view_only" | "checked_out_by_me" | "locked_by_other" | "revoked_checkout"
    active_checkout_id: Optional[str] = None
    message: str = ""


class ReapplyMergeReport(BaseModel):
    applied_changes: List[str] = Field(default_factory=list)
    conflicts_skipped: List[str] = Field(default_factory=list)
    base_version: int
    target_remote_version: int


class CheckoutAndReapplyResponse(BaseModel):
    summary: RemoteModelSummary
    project: ProjectMetamodel
    work_mode: str
    active_checkout_id: str
    merge_report: ReapplyMergeReport
    message: str


# ---------------------------------------------------------------------------
# Filesystem Helpers
# ---------------------------------------------------------------------------
def get_remote_repo_dir() -> Path:
    repo_dir = settings.canonical_model_path.parent / "remote_repo"
    repo_dir.mkdir(parents=True, exist_ok=True)
    return repo_dir


def get_local_checkout_path(user_email: str, model_id: str) -> Path:
    safe_email = re.sub(r"[^a-zA-Z0-9_.-]", "_", user_email.lower())
    user_dir = settings.canonical_model_path.parent / "local_checkouts" / safe_email
    user_dir.mkdir(parents=True, exist_ok=True)
    return user_dir / f"{model_id}.json"


def write_remote_model_file(model_id: str, project: ProjectMetamodel) -> Path:
    target = get_remote_repo_dir() / f"{model_id}.json"
    target.write_text(project.model_dump_json(indent=2), encoding="utf-8")
    return target


def write_local_checkout_file(user_email: str, model_id: str, project: ProjectMetamodel) -> Path:
    target = get_local_checkout_path(user_email, model_id)
    target.write_text(project.model_dump_json(indent=2), encoding="utf-8")
    return target


# ---------------------------------------------------------------------------
# Seeding & Initialization
# ---------------------------------------------------------------------------
def ensure_remote_repo_seeded(db: Session) -> None:
    """Seed the default Enterprise Insurance model into the remote repository and initialize user ACLs."""
    existing = db.query(RemoteModelRecord).filter(RemoteModelRecord.id == DEFAULT_REMOTE_MODEL_ID).first()
    if not existing:
        seed_model = ensure_seed_workspace(settings.canonical_model_path)
        now = datetime.now(timezone.utc)
        rec = RemoteModelRecord(
            id=DEFAULT_REMOTE_MODEL_ID,
            name=seed_model.name,
            description=getattr(seed_model, "description", None) or "Enterprise Canonical Data Model in Shared Repository",
            current_version=1,
            version_tag=f"v{seed_model.version}",
            model_json=seed_model.model_dump_json(indent=2),
            created_by_email="admin@metaforge.local",
            is_locked=False,
            updated_at=now,
            created_at=now,
        )
        db.add(rec)
        db.commit()
        write_remote_model_file(DEFAULT_REMOTE_MODEL_ID, seed_model)

    # Ensure default permissions exist for all users on DEFAULT_REMOTE_MODEL_ID
    users = db.query(UserRecord).all()
    for u in users:
        acc = (
            db.query(RemoteModelAccessRecord)
            .filter(
                RemoteModelAccessRecord.model_id == DEFAULT_REMOTE_MODEL_ID,
                RemoteModelAccessRecord.user_email == u.email,
            )
            .first()
        )
        if not acc:
            if u.role == UserRole.ADMIN.value:
                perm = "ADMIN"
            elif u.role in (UserRole.ARCHITECT.value, UserRole.STEWARD.value):
                perm = "EDIT"
            else:
                perm = "VIEW"
            db.add(
                RemoteModelAccessRecord(
                    model_id=DEFAULT_REMOTE_MODEL_ID,
                    user_email=u.email,
                    permission=perm,
                    granted_by_email="admin@metaforge.local",
                )
            )
    db.commit()


# ---------------------------------------------------------------------------
# Access Control (ACL) Resolution
# ---------------------------------------------------------------------------
def get_effective_permission(db: Session, model_id: str, user: UserProfile) -> str:
    """Resolve a user's effective permission ('NONE', 'VIEW', 'EDIT', 'ADMIN') on a remote model."""
    if user.role == UserRole.ADMIN:
        return "ADMIN"
    rec = (
        db.query(RemoteModelAccessRecord)
        .filter(
            RemoteModelAccessRecord.model_id == model_id,
            RemoteModelAccessRecord.user_email == user.email.lower(),
        )
        .first()
    )
    if rec:
        return rec.permission.upper()
    # Shared models are visible only to members an Admin has granted access to.
    return "NONE"


def build_remote_model_summary(
    db: Session,
    rec: RemoteModelRecord,
    user: UserProfile,
) -> RemoteModelSummary:
    perm = get_effective_permission(db, rec.id, user)
    try:
        parsed = json.loads(rec.model_json)
        ent_count = len(parsed.get("entities", {}))
        rel_count = len(parsed.get("relationships", {}))
    except Exception:
        ent_count = 0
        rel_count = 0

    # Check if this user has a FORCE_RELEASED checkout session that hasn't been reapplied yet
    revoked_sess = (
        db.query(RemoteCheckoutSessionRecord)
        .filter(
            RemoteCheckoutSessionRecord.model_id == rec.id,
            RemoteCheckoutSessionRecord.user_email == user.email.lower(),
            RemoteCheckoutSessionRecord.status == "FORCE_RELEASED",
        )
        .order_by(RemoteCheckoutSessionRecord.updated_at.desc())
        .first()
    )
    revoked_summary = None
    if revoked_sess:
        revoked_summary = RevokedSessionSummary(
            checkout_id=revoked_sess.checkout_id,
            base_version=revoked_sess.base_version,
            force_released_by_email=revoked_sess.force_released_by_email,
            force_released_reason=revoked_sess.force_released_reason,
            force_released_at=revoked_sess.force_released_at.isoformat() if revoked_sess.force_released_at else None,
            has_saved_draft=bool(revoked_sess.local_draft_json),
        )

    return RemoteModelSummary(
        id=rec.id,
        name=rec.name,
        description=rec.description,
        current_version=rec.current_version,
        version_tag=rec.version_tag,
        entity_count=ent_count,
        relationship_count=rel_count,
        created_by_email=rec.created_by_email,
        is_locked=rec.is_locked,
        checked_out_by_email=rec.checked_out_by_email,
        checked_out_by_name=rec.checked_out_by_name,
        checked_out_at=rec.checked_out_at.isoformat() if rec.checked_out_at else None,
        checkout_id=rec.checkout_id,
        updated_at=rec.updated_at.isoformat() if rec.updated_at else "",
        user_permission=perm,
        revoked_session=revoked_summary,
    )


def list_remote_models(db: Session, user: UserProfile) -> List[RemoteModelSummary]:
    ensure_remote_repo_seeded(db)
    records = db.query(RemoteModelRecord).order_by(RemoteModelRecord.updated_at.desc()).all()
    results: List[RemoteModelSummary] = []
    for rec in records:
        perm = get_effective_permission(db, rec.id, user)
        if perm == "NONE":
            continue
        results.append(build_remote_model_summary(db, rec, user))
    return results


def get_model_access_list(db: Session, model_id: str) -> List[ModelAccessEntry]:
    ensure_remote_repo_seeded(db)
    users = db.query(UserRecord).order_by(UserRecord.id.asc()).all()
    access_records = (
        db.query(RemoteModelAccessRecord)
        .filter(RemoteModelAccessRecord.model_id == model_id)
        .all()
    )
    access_map = {a.user_email.lower(): a.permission.upper() for a in access_records}

    entries: List[ModelAccessEntry] = []
    for u in users:
        email_key = u.email.lower()
        if u.role == UserRole.ADMIN.value:
            perm = "ADMIN"
        elif email_key in access_map:
            perm = access_map[email_key]
        elif u.role in (UserRole.ARCHITECT.value, UserRole.STEWARD.value):
            perm = "EDIT"
        else:
            perm = "VIEW"
        entries.append(
            ModelAccessEntry(
                user_email=u.email,
                full_name=u.full_name,
                user_role=u.role,
                permission=perm,
            )
        )
    return entries


def update_model_access_list(
    db: Session,
    model_id: str,
    updates: List[ModelAccessEntry],
    admin_user: UserProfile,
) -> List[ModelAccessEntry]:
    if admin_user.role != UserRole.ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only an Admin can configure user access permissions on remote models.",
        )

    now = datetime.now(timezone.utc)
    for item in updates:
        perm = item.permission.upper().strip()
        if perm not in ("NONE", "VIEW", "EDIT", "ADMIN"):
            raise HTTPException(status_code=400, detail=f"Invalid permission '{perm}'.")

        existing = (
            db.query(RemoteModelAccessRecord)
            .filter(
                RemoteModelAccessRecord.model_id == model_id,
                RemoteModelAccessRecord.user_email == item.user_email.lower(),
            )
            .first()
        )
        if existing:
            existing.permission = perm
            existing.granted_by_email = admin_user.email
            existing.updated_at = now
        else:
            db.add(
                RemoteModelAccessRecord(
                    model_id=model_id,
                    user_email=item.user_email.lower(),
                    permission=perm,
                    granted_by_email=admin_user.email,
                    updated_at=now,
                )
            )

    db.add(
        AuditLogRecord(
            actor_email=admin_user.email,
            actor_role=admin_user.role.value,
            action="UPDATE_MODEL_ACCESS",
            details=f"Updated user access control list on model {model_id}",
        )
    )
    db.commit()
    return get_model_access_list(db, model_id)


# ---------------------------------------------------------------------------
# View-Only, Checkout, Check-In, Force Release & Create Remote Model
# ---------------------------------------------------------------------------
def create_new_remote_model(
    db: Session,
    name: str,
    description: str,
    project: Optional[ProjectMetamodel],
    user: UserProfile,
) -> RemoteModelSummary:
    ensure_remote_repo_seeded(db)
    if user.role not in (UserRole.ADMIN, UserRole.ARCHITECT):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Admin or Data Architect can register new models in the remote repository.",
        )
    if project is None:
        project = ensure_seed_workspace(settings.canonical_model_path).model_copy(deep=True)
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "model"
    model_id = f"model-{slug}-{uuid.uuid4().hex[:6]}"
    project.name = name

    now = datetime.now(timezone.utc)
    rec = RemoteModelRecord(
        id=model_id,
        name=name,
        description=description,
        current_version=1,
        version_tag="v1.0.0",
        model_json=project.model_dump_json(indent=2),
        created_by_email=user.email,
        is_locked=False,
        updated_at=now,
        created_at=now,
    )
    db.add(rec)
    db.add(
        RemoteModelAccessRecord(
            model_id=model_id,
            user_email=user.email.lower(),
            permission="ADMIN" if user.role == UserRole.ADMIN else "EDIT",
            granted_by_email=user.email,
            updated_at=now,
        )
    )
    db.commit()
    db.refresh(rec)
    write_remote_model_file(model_id, project)

    return build_remote_model_summary(db, rec, user)


def view_remote_model(
    db: Session,
    model_id: str,
    user: UserProfile,
) -> RemoteModelDetailResponse:
    """Open a model from the remote directory in View-Only mode without checking it out."""
    ensure_remote_repo_seeded(db)
    rec = db.query(RemoteModelRecord).filter(RemoteModelRecord.id == model_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail=f"Remote model '{model_id}' not found.")

    perm = get_effective_permission(db, model_id, user)
    if perm == "NONE":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to view this remote model.",
        )

    project = ProjectMetamodel.model_validate_json(rec.model_json)
    summary = build_remote_model_summary(db, rec, user)

    # Even if it's checked out by this user, calling /view explicitly lets them inspect remote state,
    # or if they already hold the lock we can report whether it's checked_out_by_me or view_only.
    # Per requirement: "make the model in remote directory available for view only without checkout."
    work_mode = "view_only"
    msg = f"Viewing '{rec.name}' ({rec.version_tag}) in View-Only mode. Check out the model to lock and edit locally."
    if rec.is_locked and rec.checked_out_by_email and rec.checked_out_by_email.lower() != user.email.lower():
        msg = (
            f"Viewing '{rec.name}' ({rec.version_tag}) in View-Only mode. "
            f"Currently checked out and locked by {rec.checked_out_by_name} ({rec.checked_out_by_email})."
        )

    return RemoteModelDetailResponse(
        summary=summary,
        project=project,
        work_mode=work_mode,
        active_checkout_id=None,
        message=msg,
    )


def checkout_remote_model(
    db: Session,
    model_id: str,
    user: UserProfile,
) -> RemoteModelDetailResponse:
    """Check out a model: locks it in the shared repo and downloads the model locally for editing."""
    ensure_remote_repo_seeded(db)
    rec = db.query(RemoteModelRecord).filter(RemoteModelRecord.id == model_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail=f"Remote model '{model_id}' not found.")

    perm = get_effective_permission(db, model_id, user)
    if perm not in ("EDIT", "ADMIN"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Your access level on '{rec.name}' is '{perm}'. You need 'EDIT' or 'ADMIN' access to check out this model.",
        )

    if rec.is_locked and rec.checked_out_by_email:
        if rec.checked_out_by_email.lower() != user.email.lower():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"Model '{rec.name}' is currently checked out and locked by "
                    f"{rec.checked_out_by_name} ({rec.checked_out_by_email}). "
                    f"Contact {rec.checked_out_by_name} to release it, or ask an Admin to force release."
                ),
            )
        # Already checked out by this user
        project = ProjectMetamodel.model_validate_json(rec.model_json)
        local_path = get_local_checkout_path(user.email, model_id)
        if local_path.exists():
            try:
                project = ProjectMetamodel.model_validate_json(local_path.read_text(encoding="utf-8"))
            except Exception:
                pass
        summary = build_remote_model_summary(db, rec, user)
        return RemoteModelDetailResponse(
            summary=summary,
            project=project,
            work_mode="checked_out_by_me",
            active_checkout_id=rec.checkout_id,
            message=f"Model '{rec.name}' is checked out and locked by you.",
        )

    # Lock model in shared repo
    now = datetime.now(timezone.utc)
    checkout_id = f"chk-{uuid.uuid4().hex[:12]}"
    rec.is_locked = True
    rec.checked_out_by_email = user.email
    rec.checked_out_by_name = user.full_name
    rec.checked_out_at = now
    rec.checkout_id = checkout_id
    rec.updated_at = now

    session_rec = RemoteCheckoutSessionRecord(
        checkout_id=checkout_id,
        model_id=model_id,
        user_email=user.email.lower(),
        user_name=user.full_name,
        base_version=rec.current_version,
        base_model_json=rec.model_json,
        local_draft_json=rec.model_json,
        status="ACTIVE",
        created_at=now,
        updated_at=now,
    )
    db.add(session_rec)
    db.add(
        AuditLogRecord(
            actor_email=user.email,
            actor_role=user.role.value,
            action="CHECKOUT_MODEL",
            details=f"Checked out and locked '{rec.name}' ({rec.version_tag}) [checkout_id={checkout_id}]",
        )
    )
    db.commit()
    db.refresh(rec)

    project = ProjectMetamodel.model_validate_json(rec.model_json)
    # Download locally for the user and update active workspace model
    write_local_checkout_file(user.email, model_id, project)
    save_workspace_model(settings.canonical_model_path, project)
    write_dbt_artifacts_to_disk(project, settings.exported_dbt_dir)

    summary = build_remote_model_summary(db, rec, user)
    return RemoteModelDetailResponse(
        summary=summary,
        project=project,
        work_mode="checked_out_by_me",
        active_checkout_id=checkout_id,
        message=f"Checked out '{rec.name}' ({rec.version_tag}). Model downloaded locally and locked in shared repository.",
    )


def save_local_checkout_draft(
    db: Session,
    model_id: str,
    user: UserProfile,
    project: ProjectMetamodel,
    checkout_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Save the user's in-progress local modifications to their local checkout file and session draft."""
    ensure_remote_repo_seeded(db)
    write_local_checkout_file(user.email, model_id, project)

    query = db.query(RemoteCheckoutSessionRecord).filter(
        RemoteCheckoutSessionRecord.model_id == model_id,
        RemoteCheckoutSessionRecord.user_email == user.email.lower(),
    )
    if checkout_id:
        sess = query.filter(RemoteCheckoutSessionRecord.checkout_id == checkout_id).first()
    else:
        sess = query.filter(RemoteCheckoutSessionRecord.status.in_(["ACTIVE", "FORCE_RELEASED"])).order_by(
            RemoteCheckoutSessionRecord.updated_at.desc()
        ).first()

    if sess:
        sess.local_draft_json = project.model_dump_json(indent=2)
        sess.updated_at = datetime.now(timezone.utc)
        db.commit()

    if not sess or sess.status == "ACTIVE":
        save_workspace_model(settings.canonical_model_path, project)
        write_dbt_artifacts_to_disk(project, settings.exported_dbt_dir)

    return {
        "status": "saved_local_draft",
        "session_status": sess.status if sess else "NONE",
        "checkout_id": sess.checkout_id if sess else checkout_id,
    }


def checkin_remote_model(
    db: Session,
    model_id: str,
    user: UserProfile,
    project: ProjectMetamodel,
    commit_message: str = "Checked in model changes to shared repository",
    checkout_id: Optional[str] = None,
) -> RemoteModelDetailResponse:
    """Check in local modifications to the shared remote repository and release the lock.
    Denies check-in if an Admin has force-released the user's checkout lock, while saving their draft for auto-reapply.
    """
    ensure_remote_repo_seeded(db)
    rec = db.query(RemoteModelRecord).filter(RemoteModelRecord.id == model_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail=f"Remote model '{model_id}' not found.")

    perm = get_effective_permission(db, model_id, user)
    if perm not in ("EDIT", "ADMIN"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to check in changes to this model.",
        )

    # Check if the user's checkout session was FORCE_RELEASED by Admin
    target_sess: Optional[RemoteCheckoutSessionRecord] = None
    if checkout_id:
        target_sess = (
            db.query(RemoteCheckoutSessionRecord)
            .filter(RemoteCheckoutSessionRecord.checkout_id == checkout_id)
            .first()
        )
    else:
        target_sess = (
            db.query(RemoteCheckoutSessionRecord)
            .filter(
                RemoteCheckoutSessionRecord.model_id == model_id,
                RemoteCheckoutSessionRecord.user_email == user.email.lower(),
                RemoteCheckoutSessionRecord.status.in_(["ACTIVE", "FORCE_RELEASED"]),
            )
            .order_by(RemoteCheckoutSessionRecord.updated_at.desc())
            .first()
        )

    if target_sess and target_sess.status == "FORCE_RELEASED":
        # Preserve the user's modified model in local_draft_json so they can auto-reapply later!
        target_sess.local_draft_json = project.model_dump_json(indent=2)
        target_sess.updated_at = datetime.now(timezone.utc)
        write_local_checkout_file(user.email, model_id, project)
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"CHECKIN_DENIED_FORCE_RELEASED: Your checkout lock on '{rec.name}' was force-released by Admin "
                f"({target_sess.force_released_by_email or 'admin'}). Direct check-in is denied. "
                f"Your local changes have been safely saved and can be automatically re-applied "
                f"(non-conflicting changes) once the model is available for checkout again."
            ),
        )

    if not rec.is_locked or not rec.checked_out_by_email or rec.checked_out_by_email.lower() != user.email.lower():
        if rec.is_locked and rec.checked_out_by_email:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"Cannot check in: Model '{rec.name}' is currently locked by "
                    f"{rec.checked_out_by_name} ({rec.checked_out_by_email})."
                ),
            )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot check in: You do not hold an active checkout lock on '{rec.name}'. Please check out the model first.",
        )

    if checkout_id and rec.checkout_id and checkout_id != rec.checkout_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Stale checkout token: Your previous checkout was superseded. Use Auto-Reapply to merge your changes.",
        )

    existing_model = ProjectMetamodel.model_validate_json(rec.model_json)
    validate_steward_restrictions(existing_model, project, user)
    apply_all_domains(project)

    now = datetime.now(timezone.utc)
    new_ver = rec.current_version + 1
    new_tag = f"v1.0.{new_ver - 1}"
    project.version = f"1.0.{new_ver - 1}"

    rec.current_version = new_ver
    rec.version_tag = new_tag
    rec.name = project.name or rec.name
    rec.model_json = project.model_dump_json(indent=2)
    rec.is_locked = False
    rec.checked_out_by_email = None
    rec.checked_out_by_name = None
    rec.checked_out_at = None
    rec.checkout_id = None
    rec.updated_at = now

    if target_sess:
        target_sess.status = "CHECKED_IN"
        target_sess.local_draft_json = rec.model_json
        target_sess.updated_at = now

    # Mark any older FORCE_RELEASED sessions for this user on this model as superseded if they just checked in cleanly
    db.add(
        ModelRevisionRecord(
            revision_tag=new_tag,
            author_email=user.email,
            author_role=user.role.value,
            commit_message=commit_message,
            subject_area="All",
            model_json=rec.model_json,
            created_at=now,
        )
    )
    db.add(
        AuditLogRecord(
            actor_email=user.email,
            actor_role=user.role.value,
            action="CHECKIN_MODEL",
            details=f"Checked in '{rec.name}' ({new_tag}): {commit_message}",
        )
    )
    db.commit()
    db.refresh(rec)

    write_remote_model_file(model_id, project)
    save_workspace_model(settings.canonical_model_path, project)
    write_dbt_artifacts_to_disk(project, settings.exported_dbt_dir)

    summary = build_remote_model_summary(db, rec, user)
    return RemoteModelDetailResponse(
        summary=summary,
        project=project,
        work_mode="view_only",
        active_checkout_id=None,
        message=f"Successfully checked in '{rec.name}' ({new_tag}) and released repository lock.",
    )


def release_remote_model_lock(
    db: Session,
    model_id: str,
    user: UserProfile,
) -> RemoteModelDetailResponse:
    """Voluntarily release a checkout lock held by the current user without checking in changes."""
    ensure_remote_repo_seeded(db)
    rec = db.query(RemoteModelRecord).filter(RemoteModelRecord.id == model_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail=f"Remote model '{model_id}' not found.")

    if not rec.is_locked or not rec.checked_out_by_email or rec.checked_out_by_email.lower() != user.email.lower():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You do not currently hold the lock on this model.",
        )

    now = datetime.now(timezone.utc)
    if rec.checkout_id:
        sess = (
            db.query(RemoteCheckoutSessionRecord)
            .filter(RemoteCheckoutSessionRecord.checkout_id == rec.checkout_id)
            .first()
        )
        if sess:
            sess.status = "RELEASED"
            sess.updated_at = now

    rec.is_locked = False
    rec.checked_out_by_email = None
    rec.checked_out_by_name = None
    rec.checked_out_at = None
    rec.checkout_id = None
    rec.updated_at = now

    db.add(
        AuditLogRecord(
            actor_email=user.email,
            actor_role=user.role.value,
            action="RELEASE_LOCK",
            details=f"Voluntarily released checkout lock on '{rec.name}'",
        )
    )
    db.commit()
    db.refresh(rec)

    project = ProjectMetamodel.model_validate_json(rec.model_json)
    save_workspace_model(settings.canonical_model_path, project)
    summary = build_remote_model_summary(db, rec, user)
    return RemoteModelDetailResponse(
        summary=summary,
        project=project,
        work_mode="view_only",
        active_checkout_id=None,
        message=f"Released checkout lock on '{rec.name}'. Reverted to remote View-Only version ({rec.version_tag}).",
    )


def force_release_remote_model_lock(
    db: Session,
    model_id: str,
    admin_user: UserProfile,
    reason: str = "Admin forced lock release",
) -> RemoteModelSummary:
    """Admin-only: Force release a lock held by another user.
    Denies the user who checked out the model the ability to check in directly,
    while preserving their session so they can later re-apply non-conflicting changes automatically.
    """
    ensure_remote_repo_seeded(db)
    if admin_user.role != UserRole.ADMIN and get_effective_permission(db, model_id, admin_user) != "ADMIN":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only an Admin can force-release a model checkout lock.",
        )

    rec = db.query(RemoteModelRecord).filter(RemoteModelRecord.id == model_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail=f"Remote model '{model_id}' not found.")

    if not rec.is_locked:
        raise HTTPException(status_code=400, detail=f"Model '{rec.name}' is not currently locked.")

    previous_holder = rec.checked_out_by_email or "unknown"
    previous_checkout_id = rec.checkout_id
    now = datetime.now(timezone.utc)

    if previous_checkout_id:
        sess = (
            db.query(RemoteCheckoutSessionRecord)
            .filter(RemoteCheckoutSessionRecord.checkout_id == previous_checkout_id)
            .first()
        )
        if sess:
            sess.status = "FORCE_RELEASED"
            sess.force_released_by_email = admin_user.email
            sess.force_released_reason = reason or "Admin forced lock release"
            sess.force_released_at = now
            sess.updated_at = now
            # If the user had a local checkout file on disk, snapshot it into local_draft_json
            local_file = get_local_checkout_path(previous_holder, model_id)
            if local_file.exists():
                try:
                    sess.local_draft_json = local_file.read_text(encoding="utf-8")
                except Exception:
                    pass

    rec.is_locked = False
    rec.checked_out_by_email = None
    rec.checked_out_by_name = None
    rec.checked_out_at = None
    rec.checkout_id = None
    rec.updated_at = now

    db.add(
        AuditLogRecord(
            actor_email=admin_user.email,
            actor_role=admin_user.role.value,
            action="FORCE_RELEASE_LOCK",
            details=(
                f"Force-released lock on '{rec.name}' held by {previous_holder} "
                f"[checkout_id={previous_checkout_id}]. Reason: {reason}"
            ),
        )
    )
    db.commit()
    db.refresh(rec)
    return build_remote_model_summary(db, rec, admin_user)


# ---------------------------------------------------------------------------
# 3-Way Non-Conflicting Change Re-Application Engine
# ---------------------------------------------------------------------------
def three_way_merge_models(
    base: ProjectMetamodel,
    remote: ProjectMetamodel,
    user_draft: ProjectMetamodel,
) -> Tuple[ProjectMetamodel, List[str], List[str]]:
    """
    3-Way Structural Merge of Canonical Data Models:
      - `base`: Model snapshot when user originally checked it out (before force-release).
      - `remote`: Current authoritative model in the shared repository.
      - `user_draft`: User's modified model from their interrupted/force-released session.

    Automatically applies all non-conflicting additions, modifications, and deletions from `user_draft`
    onto `remote`, while skipping and reporting any conflicting changes where `remote` also modified
    the same item/property differently since `base`.
    """
    merged = ProjectMetamodel.model_validate_json(remote.model_dump_json())
    applied: List[str] = []
    conflicts: List[str] = []

    # Helper lookup maps by physical_name.upper() and id
    def _find_entity(model: ProjectMetamodel, ent_id: str, phys_name: str) -> Optional[EntityModel]:
        if ent_id in model.entities:
            return model.entities[ent_id]
        for e in model.entities.values():
            if e.physical_name.upper() == phys_name.upper():
                return e
        return None

    # 1. Subject Areas
    for sa in user_draft.subject_areas:
        if sa not in merged.subject_areas:
            merged.subject_areas.append(sa)
            applied.append(f"Added Subject Area '{sa}'")

    # 2. Enterprise Domains
    for dom_id, dom in user_draft.domains.items():
        if dom_id not in base.domains and dom_id not in merged.domains:
            merged.domains[dom_id] = dom.model_copy(deep=True)
            applied.append(f"Added Enterprise Domain '{dom.name}'")

    # 3. Entities & Columns
    # 3a. Check entities added or modified in user_draft
    for draft_ent_id, draft_ent in user_draft.entities.items():
        base_ent = _find_entity(base, draft_ent_id, draft_ent.physical_name)
        remote_ent = _find_entity(merged, draft_ent_id, draft_ent.physical_name)

        if base_ent is None:
            # Entity was ADDED by the user
            if remote_ent is None:
                merged.entities[draft_ent.id] = draft_ent.model_copy(deep=True)
                applied.append(f"Added {draft_ent.entity_type} '{draft_ent.physical_name}' ({len(draft_ent.columns)} columns)")
            else:
                # Both user and remote added an entity with the same name! Merge non-conflicting columns
                remote_col_names = {c.physical_name.upper() for c in remote_ent.columns}
                added_cols = 0
                for c in draft_ent.columns:
                    if c.physical_name.upper() not in remote_col_names:
                        remote_ent.columns.append(c.model_copy(deep=True))
                        added_cols += 1
                if added_cols > 0:
                    applied.append(
                        f"Merged {added_cols} new column(s) into concurrently created table '{remote_ent.physical_name}'"
                    )
                else:
                    conflicts.append(
                        f"Table '{draft_ent.physical_name}' was also created in remote; kept remote table definition"
                    )
        else:
            # Entity existed in base; check if user modified it
            if remote_ent is None:
                # Entity was dropped in remote since base
                if draft_ent.model_dump() != base_ent.model_dump():
                    conflicts.append(
                        f"Skipped modifications to '{draft_ent.physical_name}' because the table was dropped in remote"
                    )
                continue

            # Compare entity-level scalar properties
            entity_props = [
                "logical_name",
                "physical_name",
                "description",
                "subject_area",
                "entity_type",
                "view_sql",
                "header_color",
            ]
            for prop in entity_props:
                b_val = getattr(base_ent, prop, None)
                d_val = getattr(draft_ent, prop, None)
                r_val = getattr(remote_ent, prop, None)
                if d_val != b_val:
                    if r_val == b_val:
                        setattr(remote_ent, prop, d_val)
                        applied.append(f"Updated {remote_ent.physical_name}.{prop} to '{d_val}'")
                    elif r_val != d_val:
                        conflicts.append(
                            f"Conflict on {remote_ent.physical_name}.{prop}: remote changed to '{r_val}' while your draft had '{d_val}' (kept remote)"
                        )

            # Compare Columns inside this entity
            base_cols_by_id = {c.id: c for c in base_ent.columns}
            base_cols_by_name = {c.physical_name.upper(): c for c in base_ent.columns}
            remote_cols_by_id = {c.id: c for c in remote_ent.columns}
            remote_cols_by_name = {c.physical_name.upper(): c for c in remote_ent.columns}
            draft_col_keys = {c.id for c in draft_ent.columns} | {c.physical_name.upper() for c in draft_ent.columns}

            for d_col in draft_ent.columns:
                b_col = base_cols_by_id.get(d_col.id) or base_cols_by_name.get(d_col.physical_name.upper())
                r_col = remote_cols_by_id.get(d_col.id) or remote_cols_by_name.get(d_col.physical_name.upper())

                if b_col is None:
                    # Column was ADDED by user
                    if r_col is None:
                        remote_ent.columns.append(d_col.model_copy(deep=True))
                        applied.append(
                            f"Added column '{d_col.physical_name}' ({d_col.data_type_snowflake}) to '{remote_ent.physical_name}'"
                        )
                    else:
                        if r_col.model_dump(exclude={"id"}) != d_col.model_dump(exclude={"id"}):
                            conflicts.append(
                                f"Conflict adding column '{d_col.physical_name}' on '{remote_ent.physical_name}': column already added in remote"
                            )
                else:
                    # Column existed in base; check if user modified it
                    if r_col is None:
                        if d_col.model_dump() != b_col.model_dump():
                            conflicts.append(
                                f"Conflict on column '{d_col.physical_name}' in '{remote_ent.physical_name}': dropped in remote while modified in your draft"
                            )
                        continue

                    col_props = [
                        "logical_name",
                        "physical_name",
                        "data_type_snowflake",
                        "data_type_sql_server",
                        "data_type_oracle",
                        "is_pk",
                        "is_fk",
                        "is_nullable",
                        "description",
                        "pii_classification",
                        "default_value",
                        "source_expression",
                    ]
                    for cprop in col_props:
                        cb_val = getattr(b_col, cprop, None)
                        cd_val = getattr(d_col, cprop, None)
                        cr_val = getattr(r_col, cprop, None)
                        if cd_val != cb_val:
                            if cr_val == cb_val:
                                setattr(r_col, cprop, cd_val)
                                applied.append(
                                    f"Updated column {remote_ent.physical_name}.{r_col.physical_name}.{cprop} -> '{cd_val}'"
                                )
                            elif cr_val != cd_val:
                                conflicts.append(
                                    f"Conflict on {remote_ent.physical_name}.{r_col.physical_name}.{cprop}: remote has '{cr_val}', your draft had '{cd_val}'"
                                )

            # Check columns DROPPED by user
            for b_col in base_ent.columns:
                if b_col.id not in draft_col_keys and b_col.physical_name.upper() not in draft_col_keys:
                    r_col = remote_cols_by_id.get(b_col.id) or remote_cols_by_name.get(b_col.physical_name.upper())
                    if r_col is not None:
                        if r_col.model_dump() == b_col.model_dump():
                            remote_ent.columns = [c for c in remote_ent.columns if c.id != r_col.id]
                            applied.append(f"Dropped column '{b_col.physical_name}' from '{remote_ent.physical_name}'")
                        else:
                            conflicts.append(
                                f"Conflict dropping column '{b_col.physical_name}' on '{remote_ent.physical_name}': column was modified in remote"
                            )

    # 3b. Check entities DROPPED by user
    for base_ent_id, base_ent in base.entities.items():
        in_draft = _find_entity(user_draft, base_ent_id, base_ent.physical_name)
        if in_draft is None:
            remote_ent = _find_entity(merged, base_ent_id, base_ent.physical_name)
            if remote_ent is not None:
                if remote_ent.model_dump() == base_ent.model_dump():
                    del merged.entities[remote_ent.id]
                    # Also remove relationships referencing it
                    merged.relationships = {
                        rid: r
                        for rid, r in merged.relationships.items()
                        if r.parent_entity_id != remote_ent.id and r.child_entity_id != remote_ent.id
                    }
                    applied.append(f"Dropped table '{base_ent.physical_name}'")
                else:
                    conflicts.append(
                        f"Conflict dropping table '{base_ent.physical_name}': table was modified in remote since your checkout"
                    )

    # 4. Relationships
    for rel_id, d_rel in user_draft.relationships.items():
        b_rel = base.relationships.get(rel_id)
        r_rel = merged.relationships.get(rel_id)
        if b_rel is None:
            # Relationship ADDED by user
            if r_rel is None:
                if d_rel.parent_entity_id in merged.entities and d_rel.child_entity_id in merged.entities:
                    merged.relationships[rel_id] = d_rel.model_copy(deep=True)
                    applied.append(f"Added relationship '{d_rel.name}'")
        else:
            if r_rel is not None:
                for rprop in ["name", "rel_type", "cardinality", "is_mandatory"]:
                    rb_val = getattr(b_rel, rprop, None)
                    rd_val = getattr(d_rel, rprop, None)
                    rr_val = getattr(r_rel, rprop, None)
                    if rd_val != rb_val:
                        if rr_val == rb_val:
                            setattr(r_rel, rprop, rd_val)
                            applied.append(f"Updated relationship {r_rel.name}.{rprop} -> '{rd_val}'")
                        elif rr_val != rd_val:
                            conflicts.append(
                                f"Conflict on relationship {r_rel.name}.{rprop}: remote has '{rr_val}', draft had '{rd_val}'"
                            )

    # Check relationships DROPPED by user
    for rel_id, b_rel in base.relationships.items():
        if rel_id not in user_draft.relationships and rel_id in merged.relationships:
            r_rel = merged.relationships[rel_id]
            if r_rel.model_dump() == b_rel.model_dump():
                del merged.relationships[rel_id]
                applied.append(f"Dropped relationship '{b_rel.name}'")
            else:
                conflicts.append(
                    f"Conflict dropping relationship '{b_rel.name}': modified in remote"
                )

    return merged, applied, conflicts


def checkout_and_reapply_non_conflicting_changes(
    db: Session,
    model_id: str,
    user: UserProfile,
    local_modified_project: Optional[ProjectMetamodel] = None,
    revoked_checkout_id: Optional[str] = None,
) -> CheckoutAndReapplyResponse:
    """When a model is available for checkout again after an Admin force-release,
    checks out the latest remote model, automatically re-applies all non-conflicting changes
    from the user's interrupted checkout session, and locks the model for the user.
    """
    ensure_remote_repo_seeded(db)
    rec = db.query(RemoteModelRecord).filter(RemoteModelRecord.id == model_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail=f"Remote model '{model_id}' not found.")

    perm = get_effective_permission(db, model_id, user)
    if perm not in ("EDIT", "ADMIN"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You need 'EDIT' or 'ADMIN' permission to check out and re-apply changes.",
        )

    if rec.is_locked and rec.checked_out_by_email and rec.checked_out_by_email.lower() != user.email.lower():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Model '{rec.name}' is currently locked by {rec.checked_out_by_name} "
                f"({rec.checked_out_by_email}). Wait until it is available for checkout."
            ),
        )

    # Locate the user's FORCE_RELEASED session
    sess_query = db.query(RemoteCheckoutSessionRecord).filter(
        RemoteCheckoutSessionRecord.model_id == model_id,
        RemoteCheckoutSessionRecord.user_email == user.email.lower(),
        RemoteCheckoutSessionRecord.status == "FORCE_RELEASED",
    )
    if revoked_checkout_id:
        revoked_sess = sess_query.filter(RemoteCheckoutSessionRecord.checkout_id == revoked_checkout_id).first()
    else:
        revoked_sess = sess_query.order_by(RemoteCheckoutSessionRecord.updated_at.desc()).first()

    if not revoked_sess:
        raise HTTPException(
            status_code=404,
            detail="No force-released checkout session with pending changes found for your account on this model.",
        )

    base_model = ProjectMetamodel.model_validate_json(revoked_sess.base_model_json)
    latest_remote_model = ProjectMetamodel.model_validate_json(rec.model_json)

    if local_modified_project is not None:
        user_draft = local_modified_project
    elif revoked_sess.local_draft_json:
        user_draft = ProjectMetamodel.model_validate_json(revoked_sess.local_draft_json)
    else:
        local_file = get_local_checkout_path(user.email, model_id)
        if local_file.exists():
            user_draft = ProjectMetamodel.model_validate_json(local_file.read_text(encoding="utf-8"))
        else:
            user_draft = base_model

    merged_project, applied_changes, conflicts_skipped = three_way_merge_models(
        base=base_model,
        remote=latest_remote_model,
        user_draft=user_draft,
    )

    now = datetime.now(timezone.utc)
    new_checkout_id = rec.checkout_id if (rec.is_locked and rec.checked_out_by_email == user.email) else f"chk-{uuid.uuid4().hex[:12]}"

    rec.is_locked = True
    rec.checked_out_by_email = user.email
    rec.checked_out_by_name = user.full_name
    rec.checked_out_at = now
    rec.checkout_id = new_checkout_id
    rec.updated_at = now

    revoked_sess.status = "REAPPLIED"
    revoked_sess.updated_at = now

    new_sess = RemoteCheckoutSessionRecord(
        checkout_id=new_checkout_id,
        model_id=model_id,
        user_email=user.email.lower(),
        user_name=user.full_name,
        base_version=rec.current_version,
        base_model_json=rec.model_json,
        local_draft_json=merged_project.model_dump_json(indent=2),
        status="ACTIVE",
        created_at=now,
        updated_at=now,
    )
    db.merge(new_sess)
    db.add(
        AuditLogRecord(
            actor_email=user.email,
            actor_role=user.role.value,
            action="REAPPLY_CHANGES",
            details=(
                f"Checked out '{rec.name}' ({rec.version_tag}) and auto-reapplied "
                f"{len(applied_changes)} non-conflicting change(s) ({len(conflicts_skipped)} conflict(s) skipped)."
            ),
        )
    )
    db.commit()
    db.refresh(rec)

    write_local_checkout_file(user.email, model_id, merged_project)
    save_workspace_model(settings.canonical_model_path, merged_project)
    write_dbt_artifacts_to_disk(merged_project, settings.exported_dbt_dir)

    summary = build_remote_model_summary(db, rec, user)
    report = ReapplyMergeReport(
        applied_changes=applied_changes,
        conflicts_skipped=conflicts_skipped,
        base_version=revoked_sess.base_version,
        target_remote_version=rec.current_version,
    )

    return CheckoutAndReapplyResponse(
        summary=summary,
        project=merged_project,
        work_mode="checked_out_by_me",
        active_checkout_id=new_checkout_id,
        merge_report=report,
        message=(
            f"Checked out '{rec.name}' ({rec.version_tag}) and automatically re-applied "
            f"{len(applied_changes)} non-conflicting change(s)"
            + (f" ({len(conflicts_skipped)} conflicting change(s) skipped)." if conflicts_skipped else ".")
        ),
    )
