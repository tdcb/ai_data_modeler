"""/api/collab/*: live editing WebSocket, comments, activity/history, sharing and invites."""
from __future__ import annotations

import json
import re
import secrets
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
)
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth.dependencies import get_current_user
from ..auth.jwt_handler import build_user_profile, decode_access_token
from ..auth.models import (
    RemoteModelAccessRecord,
    RemoteModelRecord,
    SessionLocal,
    UserProfile,
    UserRecord,
    UserRole,
    get_db,
)
from ..config import settings
from ..metamodel.glossary import sanitize_model_business_text
from ..metamodel.schema import ProjectMetamodel
from ..metamodel.seed import ensure_seed_workspace, save_workspace_model
from .hub import Peer, hub
from .models import CollabActivityRecord, CollabCommentRecord, CollabInviteRecord

router = APIRouter(prefix="/api/collab", tags=["collab"])

WORKSPACE = "workspace"
RANK = {"NONE": 0, "VIEW": 1, "COMMENT": 2, "EDIT": 3, "ADMIN": 4}
ROLE_LABEL = {"VIEW": "Viewer", "COMMENT": "Commenter", "EDIT": "Editor", "ADMIN": "Owner"}
MAX_SNAPSHOTS = 200


def permission(db: Session, model_id: str, user: UserProfile) -> str:
    if user.role == UserRole.ADMIN:
        return "ADMIN"
    rec = (db.query(RemoteModelAccessRecord)
           .filter(RemoteModelAccessRecord.model_id == model_id,
                   RemoteModelAccessRecord.user_email == user.email.lower()).first())
    if rec:
        return rec.permission.upper()
    if model_id != WORKSPACE:
        return "NONE"
    if user.role in (UserRole.ARCHITECT, UserRole.STEWARD):
        return "EDIT"
    return "VIEW"


def _require_admin(user: UserProfile) -> None:
    if user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="Only an Admin can grant or change access to a model")


def _require(db: Session, model_id: str, user: UserProfile, needed: str) -> str:
    perm = permission(db, model_id, user)
    if RANK.get(perm, 0) < RANK[needed]:
        raise HTTPException(status_code=403, detail=f"Requires {ROLE_LABEL.get(needed, needed)} access to this model")
    return perm


def _load_project(db: Session, model_id: str) -> Optional[ProjectMetamodel]:
    if model_id == WORKSPACE:
        return ensure_seed_workspace(settings.canonical_model_path)
    rec = db.query(RemoteModelRecord).filter(RemoteModelRecord.id == model_id).first()
    return ProjectMetamodel.model_validate_json(rec.model_json) if rec else None


def _current(db: Session, room, model_id: str) -> Optional[Dict[str, Any]]:
    if room.current is None:
        loaded = _load_project(db, model_id)
        if loaded:
            room.remember(loaded.model_dump(mode="json"))
    return room.current


def _normalize(model_id: str, project: ProjectMetamodel) -> ProjectMetamodel:
    # The workspace loader sanitizes business text; apply it to live edits too so reloads never diverge.
    if model_id == WORKSPACE:
        sanitize_model_business_text(project)
    return project


def _persist(db: Session, model_id: str, project: ProjectMetamodel, editor_email: str) -> None:
    if model_id == WORKSPACE:
        save_workspace_model(settings.canonical_model_path, project)
        return
    rec = db.query(RemoteModelRecord).filter(RemoteModelRecord.id == model_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="Model not found")
    if rec.is_locked and rec.checked_out_by_email and rec.checked_out_by_email.lower() != editor_email.lower():
        raise HTTPException(status_code=409, detail=f"Model is checked out by {rec.checked_out_by_name} (governed mode)")
    rec.model_json = project.model_dump_json()
    rec.updated_at = datetime.now(timezone.utc)
    db.commit()


def _record(db: Session, model_id: str, user_email: str, user_name: str, kind: str, summary: str,
            version: int = 0, snapshot: Optional[str] = None) -> CollabActivityRecord:
    rec = CollabActivityRecord(model_id=model_id, version=version, actor_email=user_email, actor_name=user_name,
                               kind=kind, summary=summary[:2000], snapshot_json=snapshot)
    db.add(rec)
    db.commit()
    if snapshot:
        old = (db.query(CollabActivityRecord)
               .filter(CollabActivityRecord.model_id == model_id, CollabActivityRecord.snapshot_json.isnot(None))
               .order_by(CollabActivityRecord.id.desc()).offset(MAX_SNAPSHOTS).all())
        for o in old:
            o.snapshot_json = None
        db.commit()
    return rec


def _activity_out(r: CollabActivityRecord) -> Dict[str, Any]:
    return {"id": r.id, "version": r.version, "actor_email": r.actor_email, "actor_name": r.actor_name,
            "kind": r.kind, "summary": r.summary, "restorable": bool(r.snapshot_json),
            "created_at": r.created_at.isoformat() if r.created_at else None}


def diff_summary(old: Optional[ProjectMetamodel], new: ProjectMetamodel) -> str:
    """Human-readable summary of what changed between two model versions."""
    if old is None:
        return "Updated the model"
    parts: List[str] = []
    o, n = old.entities, new.entities
    added = [n[k].physical_name for k in n.keys() - o.keys()]
    dropped = [o[k].physical_name for k in o.keys() - n.keys()]
    if added:
        parts.append("added " + ", ".join(sorted(added)[:5]))
    if dropped:
        parts.append("dropped " + ", ".join(sorted(dropped)[:5]))
    for k in n.keys() & o.keys():
        a, b = o[k], n[k]
        if a == b:
            continue
        ac = {c.id: c for c in a.columns}
        bc = {c.id: c for c in b.columns}
        bits = []
        if a.physical_name != b.physical_name:
            bits.append(f"renamed to {b.physical_name}")
        new_cols = [bc[c].physical_name for c in bc.keys() - ac.keys()]
        gone = [ac[c].physical_name for c in ac.keys() - bc.keys()]
        if new_cols:
            bits.append("+" + ", ".join(new_cols[:4]))
        if gone:
            bits.append("-" + ", ".join(gone[:4]))
        changed = [bc[c].physical_name for c in bc.keys() & ac.keys() if bc[c] != ac[c]]
        if changed:
            bits.append("edited " + ", ".join(changed[:4]))
        if not bits and (a.description != b.description or a.logical_name != b.logical_name):
            bits.append("edited definition")
        if not bits and a.position != b.position:
            continue
        if bits:
            parts.append(f"{b.physical_name}: " + "; ".join(bits))
    rel_add = len(new.relationships.keys() - old.relationships.keys())
    rel_drop = len(old.relationships.keys() - new.relationships.keys())
    if rel_add:
        parts.append(f"+{rel_add} relationship(s)")
    if rel_drop:
        parts.append(f"-{rel_drop} relationship(s)")
    if not parts:
        return "Moved tables on the canvas" if old.entities != new.entities else "Updated model settings"
    return "; ".join(parts)[:500]


def three_way_merge(base: Dict[str, Any], theirs: Dict[str, Any], mine: Dict[str, Any]):
    """Merge an edit made against `base` into the current server state `theirs`.

    Tables and relationships merge independently; when both sides changed the same one the incoming
    (later) edit wins and its name is reported as a conflict.
    """
    out = dict(theirs)
    conflicts: List[str] = []
    for key in set(mine) | set(theirs):
        if key in ("entities", "relationships"):
            b, t, m = base.get(key) or {}, theirs.get(key) or {}, mine.get(key) or {}
            merged: Dict[str, Any] = {}
            for oid in set(b) | set(t) | set(m):
                bv, tv, mv = b.get(oid), t.get(oid), m.get(oid)
                if mv != bv:
                    if tv != bv and tv != mv:
                        item = mv or tv or bv or {}
                        conflicts.append(str(item.get("physical_name") or item.get("name") or oid))
                    val = mv
                else:
                    val = tv
                if val is not None:
                    merged[oid] = val
            out[key] = merged
        elif mine.get(key) != base.get(key):
            out[key] = mine.get(key)
    return out, conflicts


def _ws_user(token: str) -> Optional[UserProfile]:
    try:
        payload = decode_access_token(token)
    except Exception:
        return None
    db = SessionLocal()
    try:
        u = db.query(UserRecord).filter(UserRecord.email == payload.get("sub")).first()
        return build_user_profile(u) if u else None
    finally:
        db.close()


@router.websocket("/ws/{model_id}")
async def collab_socket(ws: WebSocket, model_id: str, token: str = Query(""), view: str = Query("canvas")):
    user = _ws_user(token)
    if not user:
        await ws.close(code=4401)
        return
    db = SessionLocal()
    try:
        perm = permission(db, model_id, user)
        if RANK.get(perm, 0) < RANK["VIEW"]:
            await ws.close(code=4403)
            return
        last = (db.query(CollabActivityRecord).filter(CollabActivityRecord.model_id == model_id)
                .order_by(CollabActivityRecord.version.desc()).first())
        room = hub.room(model_id, last.version if last else 0)
        await ws.accept()
        peer = Peer(ws=ws, client_id=uuid.uuid4().hex[:10], email=user.email, name=user.full_name or user.email,
                    role=perm, color=room.next_color(), view=view)
        room.peers[peer.client_id] = peer
        await ws.send_json({"type": "welcome", "version": room.version, "you": peer.public(),
                            "peers": hub.peers(model_id), "project": _current(db, room, model_id)})
        await hub.broadcast(model_id, {"type": "peer_joined", "peer": peer.public()}, exclude=peer.client_id)
        while True:
            msg = await ws.receive_json()
            kind = msg.get("type")
            if kind == "presence":
                peer.selection = msg.get("selection") or {}
                peer.view = str(msg.get("view") or peer.view)
                await hub.broadcast(model_id, {"type": "presence", "peer": peer.public()}, exclude=peer.client_id)
            elif kind == "set_project":
                if RANK.get(perm, 0) < RANK["EDIT"]:
                    await ws.send_json({"type": "error", "message": "You have read-only access to this model."})
                    continue
                async with room.lock:
                    try:
                        incoming = ProjectMetamodel.model_validate(msg.get("project") or {}).model_dump(mode="json")
                        theirs = _current(db, room, model_id) or incoming
                        before = ProjectMetamodel.model_validate(theirs)
                        base_version = int(msg.get("base_version", room.version))
                        base = room.history.get(base_version, theirs)
                        merged, conflicts = three_way_merge(base, theirs, incoming)
                        project = _normalize(model_id, ProjectMetamodel.model_validate(merged))
                        _persist(db, model_id, project, user.email)
                    except HTTPException as e:
                        await ws.send_json({"type": "error", "message": e.detail})
                        continue
                    except Exception as e:  # invalid payload
                        await ws.send_json({"type": "error", "message": f"Rejected edit: {str(e)[:200]}"})
                        continue
                    room.version += 1
                    summary = msg.get("summary") or diff_summary(before, project)
                    _record(db, model_id, user.email, peer.name, "edit", summary, room.version,
                            project.model_dump_json())
                    dumped = project.model_dump(mode="json")
                    room.remember(dumped)
                    out = {"type": "project", "version": room.version, "project": dumped,
                           "author": peer.public(), "summary": summary, "conflicts": conflicts}
                    await hub.broadcast(model_id, out, exclude=peer.client_id)
                    await ws.send_json({"type": "ack", "version": room.version, "summary": summary,
                                        "project": dumped, "conflicts": conflicts})
            elif kind == "ping":
                await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        db.close()
        r = hub.rooms.get(model_id)
        if r and "peer" in locals():
            r.peers.pop(peer.client_id, None)
            await hub.broadcast(model_id, {"type": "peer_left", "client_id": peer.client_id})


class CommentIn(BaseModel):
    body: str
    thread_id: Optional[str] = None
    target_type: str = "model"
    entity_id: Optional[str] = None
    column_id: Optional[str] = None
    relationship_id: Optional[str] = None


class CommentPatch(BaseModel):
    resolved: Optional[bool] = None
    body: Optional[str] = None


def _comment_out(c: CollabCommentRecord) -> Dict[str, Any]:
    return {"id": c.id, "thread_id": c.thread_id, "parent_id": c.parent_id, "target_type": c.target_type,
            "entity_id": c.entity_id, "column_id": c.column_id, "relationship_id": c.relationship_id,
            "author_email": c.author_email, "author_name": c.author_name, "body": c.body,
            "mentions": json.loads(c.mentions or "[]"), "resolved": c.resolved,
            "created_at": c.created_at.isoformat() if c.created_at else None}


def _mentions(db: Session, body: str) -> List[str]:
    found = set(m.lower() for m in re.findall(r"@([\w.+-]+@[\w-]+\.[\w.]+)", body))
    names = re.findall(r"@([A-Za-z][\w.-]*)", body)
    if names:
        for u in db.query(UserRecord).all():
            first = (u.full_name or "").split(" ")[0].lower()
            local = u.email.split("@")[0].lower()
            if any(n.lower() in (first, local) for n in names):
                found.add(u.email.lower())
    return sorted(found)


@router.get("/{model_id}/comments")
def list_comments(model_id: str, user: UserProfile = Depends(get_current_user), db: Session = Depends(get_db)):
    _require(db, model_id, user, "VIEW")
    rows = (db.query(CollabCommentRecord).filter(CollabCommentRecord.model_id == model_id)
            .order_by(CollabCommentRecord.id).all())
    return [_comment_out(c) for c in rows]


@router.post("/{model_id}/comments")
async def add_comment(model_id: str, payload: CommentIn, user: UserProfile = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    _require(db, model_id, user, "COMMENT")
    if not payload.body.strip():
        raise HTTPException(status_code=400, detail="Comment is empty")
    parent = None
    if payload.thread_id:
        parent = (db.query(CollabCommentRecord).filter(CollabCommentRecord.thread_id == payload.thread_id,
                                                      CollabCommentRecord.model_id == model_id)
                  .order_by(CollabCommentRecord.id).first())
        if not parent:
            raise HTTPException(status_code=404, detail="Thread not found")
    c = CollabCommentRecord(
        model_id=model_id, thread_id=payload.thread_id or uuid.uuid4().hex[:12], parent_id=parent.id if parent else None,
        target_type=parent.target_type if parent else payload.target_type,
        entity_id=parent.entity_id if parent else payload.entity_id,
        column_id=parent.column_id if parent else payload.column_id,
        relationship_id=parent.relationship_id if parent else payload.relationship_id,
        author_email=user.email, author_name=user.full_name or user.email, body=payload.body.strip()[:5000],
        mentions=json.dumps(_mentions(db, payload.body)))
    if parent:
        db.query(CollabCommentRecord).filter(CollabCommentRecord.thread_id == c.thread_id).update({"resolved": False})
    db.add(c)
    db.commit()
    db.refresh(c)
    _record(db, model_id, user.email, c.author_name, "comment", f"commented: {c.body[:120]}")
    out = _comment_out(c)
    await hub.broadcast(model_id, {"type": "comment", "comment": out})
    return out


@router.patch("/comments/{comment_id}")
async def patch_comment(comment_id: int, patch: CommentPatch, user: UserProfile = Depends(get_current_user),
                        db: Session = Depends(get_db)):
    c = db.query(CollabCommentRecord).filter(CollabCommentRecord.id == comment_id).first()
    if not c:
        raise HTTPException(status_code=404, detail="Comment not found")
    _require(db, c.model_id, user, "COMMENT")
    if patch.body is not None:
        if c.author_email.lower() != user.email.lower():
            raise HTTPException(status_code=403, detail="You can only edit your own comments")
        c.body = patch.body.strip()[:5000]
    if patch.resolved is not None:
        db.query(CollabCommentRecord).filter(CollabCommentRecord.thread_id == c.thread_id).update(
            {"resolved": patch.resolved, "resolved_by_email": user.email if patch.resolved else None})
        _record(db, c.model_id, user.email, user.full_name or user.email, "resolve",
                ("resolved" if patch.resolved else "reopened") + f" a thread: {c.body[:80]}")
    db.commit()
    rows = db.query(CollabCommentRecord).filter(CollabCommentRecord.thread_id == c.thread_id).all()
    out = [_comment_out(r) for r in rows]
    await hub.broadcast(c.model_id, {"type": "thread", "thread_id": c.thread_id, "comments": out})
    return out


@router.delete("/comments/{comment_id}")
async def delete_comment(comment_id: int, user: UserProfile = Depends(get_current_user), db: Session = Depends(get_db)):
    c = db.query(CollabCommentRecord).filter(CollabCommentRecord.id == comment_id).first()
    if not c:
        raise HTTPException(status_code=404, detail="Comment not found")
    perm = permission(db, c.model_id, user)
    if c.author_email.lower() != user.email.lower() and perm != "ADMIN":
        raise HTTPException(status_code=403, detail="Only the author or an owner can delete a comment")
    model_id, thread_id = c.model_id, c.thread_id
    db.delete(c)
    db.commit()
    rows = db.query(CollabCommentRecord).filter(CollabCommentRecord.thread_id == thread_id).all()
    await hub.broadcast(model_id, {"type": "thread", "thread_id": thread_id, "comments": [_comment_out(r) for r in rows]})
    return {"deleted": True}


@router.get("/{model_id}/activity")
def activity(model_id: str, limit: int = 100, user: UserProfile = Depends(get_current_user),
             db: Session = Depends(get_db)):
    _require(db, model_id, user, "VIEW")
    rows = (db.query(CollabActivityRecord).filter(CollabActivityRecord.model_id == model_id)
            .order_by(CollabActivityRecord.id.desc()).limit(min(limit, 500)).all())
    return [_activity_out(r) for r in rows]


@router.post("/{model_id}/restore/{activity_id}")
async def restore(model_id: str, activity_id: int, user: UserProfile = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    _require(db, model_id, user, "EDIT")
    rec = (db.query(CollabActivityRecord)
           .filter(CollabActivityRecord.id == activity_id, CollabActivityRecord.model_id == model_id).first())
    if not rec or not rec.snapshot_json:
        raise HTTPException(status_code=404, detail="That version can no longer be restored")
    project = ProjectMetamodel.model_validate_json(rec.snapshot_json)
    room = hub.room(model_id)
    async with room.lock:
        _normalize(model_id, project)
        _persist(db, model_id, project, user.email)
        room.version += 1
        room.remember(project.model_dump(mode="json"))
        summary = f"restored version {rec.version} ({rec.actor_name}: {rec.summary[:80]})"
        _record(db, model_id, user.email, user.full_name or user.email, "restore", summary, room.version,
                project.model_dump_json())
    msg = {"type": "project", "version": room.version, "project": project.model_dump(mode="json"),
           "author": {"name": user.full_name or user.email, "email": user.email, "color": "#94a3b8"},
           "summary": summary, "conflicts": []}
    await hub.broadcast(model_id, msg)
    return {"version": room.version, "project": project, "summary": summary}


class InviteIn(BaseModel):
    email: Optional[str] = None
    role: str = "VIEW"


@router.get("/{model_id}/members")
def members(model_id: str, user: UserProfile = Depends(get_current_user), db: Session = Depends(get_db)):
    my = _require(db, model_id, user, "VIEW")
    out = []
    for u in db.query(UserRecord).all():
        prof = build_user_profile(u)
        out.append({"email": u.email, "name": u.full_name, "app_role": prof.role.value,
                    "permission": permission(db, model_id, prof)})
    online = {p["email"] for p in hub.peers(model_id)}
    for m in out:
        m["online"] = m["email"] in online
    invites = []
    if user.role == UserRole.ADMIN:
        invites = [{"token": i.token, "email": i.email, "role": i.role, "accepted_by_email": i.accepted_by_email,
                    "created_at": i.created_at.isoformat() if i.created_at else None}
                   for i in db.query(CollabInviteRecord).filter(CollabInviteRecord.model_id == model_id,
                                                               CollabInviteRecord.revoked.is_(False)).all()]
    return {"my_permission": my, "can_manage": user.role == UserRole.ADMIN, "members": out, "invites": invites}


def _grant(db: Session, model_id: str, email: str, role: str, by: str) -> None:
    rec = (db.query(RemoteModelAccessRecord).filter(RemoteModelAccessRecord.model_id == model_id,
                                                   RemoteModelAccessRecord.user_email == email.lower()).first())
    if rec:
        rec.permission, rec.granted_by_email, rec.updated_at = role, by, datetime.now(timezone.utc)
    else:
        db.add(RemoteModelAccessRecord(model_id=model_id, user_email=email.lower(), permission=role,
                                       granted_by_email=by))
    db.commit()


@router.post("/{model_id}/invites")
async def create_invite(model_id: str, payload: InviteIn, user: UserProfile = Depends(get_current_user),
                        db: Session = Depends(get_db)):
    _require_admin(user)
    role = payload.role.upper()
    if role not in ("VIEW", "COMMENT", "EDIT", "ADMIN"):
        raise HTTPException(status_code=400, detail="Role must be VIEW, COMMENT, EDIT or ADMIN")
    inv = CollabInviteRecord(token=secrets.token_urlsafe(18), model_id=model_id,
                             email=(payload.email or "").strip().lower() or None, role=role,
                             created_by_email=user.email)
    db.add(inv)
    db.commit()
    existing = db.query(UserRecord).filter(UserRecord.email == inv.email).first() if inv.email else None
    if existing:
        _grant(db, model_id, existing.email, role, user.email)
        inv.accepted_by_email = existing.email
        db.commit()
    _record(db, model_id, user.email, user.full_name or user.email, "share",
            f"shared with {inv.email or 'anyone with the link'} as {ROLE_LABEL[role]}")
    await hub.broadcast(model_id, {"type": "members_changed"})
    return {"token": inv.token, "email": inv.email, "role": role, "accepted": bool(existing),
            "link": f"/?invite={inv.token}"}


@router.delete("/invites/{token}")
async def revoke_invite(token: str, user: UserProfile = Depends(get_current_user), db: Session = Depends(get_db)):
    inv = db.query(CollabInviteRecord).filter(CollabInviteRecord.token == token).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invite not found")
    _require_admin(user)
    inv.revoked = True
    db.commit()
    return {"revoked": True}


@router.put("/{model_id}/members/{email}")
async def set_member_role(model_id: str, email: str, payload: InviteIn, user: UserProfile = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    _require_admin(user)
    role = payload.role.upper()
    if role not in RANK:
        raise HTTPException(status_code=400, detail="Unknown role")
    _grant(db, model_id, email, role, user.email)
    _record(db, model_id, user.email, user.full_name or user.email, "share", f"set {email} to {ROLE_LABEL.get(role, role)}")
    await hub.broadcast(model_id, {"type": "members_changed"})
    return {"email": email, "permission": role}


@router.post("/invites/{token}/accept")
async def accept_invite(token: str, user: UserProfile = Depends(get_current_user), db: Session = Depends(get_db)):
    inv = db.query(CollabInviteRecord).filter(CollabInviteRecord.token == token).first()
    if not inv or inv.revoked:
        raise HTTPException(status_code=404, detail="This invite link is invalid or was revoked")
    if inv.email and inv.email != user.email.lower():
        raise HTTPException(status_code=403, detail="This invite was sent to a different email address")
    if RANK.get(permission(db, inv.model_id, user), 0) < RANK[inv.role]:
        _grant(db, inv.model_id, user.email, inv.role, inv.created_by_email)
    inv.accepted_by_email = user.email
    db.commit()
    _record(db, inv.model_id, user.email, user.full_name or user.email, "join", f"joined as {ROLE_LABEL[inv.role]}")
    await hub.broadcast(inv.model_id, {"type": "members_changed"})
    return {"model_id": inv.model_id, "permission": permission(db, inv.model_id, user)}
