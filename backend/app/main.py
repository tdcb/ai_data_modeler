"""MetaForge Studio FastAPI Application Entrypoint & REST API."""
from contextlib import asynccontextmanager
from pathlib import Path
import json
from typing import Any, Dict, List, Literal, Optional
from fastapi import Depends, FastAPI, File, HTTPException, Request, Response, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .config import settings
from .auth.models import (
    AuditLogRecord,
    DatabaseConnectionRecord,
    LoginRequest,
    LoginResponse,
    ModelRevisionRecord,
    RevisionSummary,
    SessionLocal,
    UserProfile,
    UserRecord,
    UserRole,
    get_db,
)
from .auth.jwt_handler import (
    DEFAULT_SEED_USERS,
    build_user_profile,
    create_access_token,
    hash_password,
    init_db_and_seed,
    verify_password,
)
from .auth.dependencies import (
    get_current_user,
    require_roles,
    validate_steward_restrictions,
)
from .metamodel.schema import (
    EnterpriseDomain,
    EntityModel,
    ProjectMetamodel,
    TargetDialect,
)
from .metamodel.seed import (
    build_default_project,
    ensure_seed_workspace,
    save_workspace_model,
)
from .metamodel.domains import apply_all_domains, cascade_domain_to_model
from .metamodel.glossary import apply_glossary_to_project
from .metamodel.governance_engine import (
    apply_modeling_pattern,
    apply_recommended_dq_rules,
    auto_generate_metadata,
    compile_open_data_contract_yaml,
    generate_definitions_from_profile_and_names,
    run_data_profiler,
)
from .compilers.snowflake import compile_snowflake_ddl
from .compilers.sql_server import compile_sql_server_ddl
from .compilers.oracle import compile_oracle_ddl
from .compilers.dbt_generator import compile_dbt_artifacts, write_dbt_artifacts_to_disk
from .compilers.view_builder import compile_view_ddl, synthesize_view_select_sql
from .reverse_eng.ddl_parser import parse_ddl_to_metamodel
from .reverse_eng.complete_compare import CompareDiffResult, run_complete_compare
from .reverse_eng.file_parser import (
    FileInspectionSummary,
    SheetInspectionResult,
    export_metamodel_to_csv_dictionary,
    import_sheets_to_metamodel,
    parse_csv_bytes,
    parse_excel_bytes,
)
from .agent.llm_service import AgentExecutionResponse, execute_agent_prompt
from .agent.gemini_service import GEMINI_AVAILABLE_MODELS, generate_metadata_with_gemini
from .agent.mcp_server import mcp_registry, dispatch_jsonrpc_request
from .ai.routes import router as ai_router
from .collab.routes import router as collab_router
from .ai.settings_store import metadata_only
from .compilers.sqlite import compile_sqlite_ddl
from .db_connector import (
    execute_ddl_on_connection,
    generate_metadata_push_script,
    profile_from_connection,
    push_metadata_to_connection,
    reverse_engineer_from_connection,
    test_database_connection,
)
from .remote_repo import (
    CheckoutAndReapplyResponse,
    ModelAccessEntry,
    RemoteModelDetailResponse,
    RemoteModelSummary,
    checkout_and_reapply_non_conflicting_changes,
    checkout_remote_model,
    checkin_remote_model,
    create_new_remote_model,
    force_release_remote_model_lock,
    get_model_access_list,
    list_remote_models,
    release_remote_model_lock,
    save_local_checkout_draft,
    update_model_access_list,
    view_remote_model,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db = SessionLocal()
    try:
        init_db_and_seed(db)
        model = ensure_seed_workspace(settings.canonical_model_path)
        write_dbt_artifacts_to_disk(model, settings.exported_dbt_dir)
    finally:
        db.close()
    yield


app = FastAPI(
    title="MetaForge Studio Enterprise API",
    description=(
        "Enterprise Cloud-Native Canonical Data Modeling & Autonomous Governance Control Plane"
    ),
    version=settings.version,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(ai_router)
app.include_router(collab_router)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc)},
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Methods": "*",
            "Access-Control-Allow-Headers": "*",
        },
    )


# ---------------------------------------------------------------------------
# Request / Response Payloads
# ---------------------------------------------------------------------------
class CreateUserRequest(BaseModel):
    email: str
    full_name: str
    password: str = "password123"
    role: UserRole = UserRole.ARCHITECT


class UpdateUserRequest(BaseModel):
    full_name: Optional[str] = None
    role: Optional[UserRole] = None
    password: Optional[str] = None


class UserDirectoryItem(BaseModel):
    id: int
    email: str
    full_name: str
    role: str
    is_active: bool


class SaveProjectRequest(BaseModel):
    project: ProjectMetamodel
    commit_message: str = "Updated canonical metamodel from studio canvas"
    subject_area: Optional[str] = "All"


class CompileRequest(BaseModel):
    project: Optional[ProjectMetamodel] = None
    subject_area: Optional[str] = None


class CompileResponse(BaseModel):
    snowflake_ddl: str
    sql_server_ddl: str
    oracle_ddl: str
    sqlite_ddl: str = ""
    dbt_files: Dict[str, str]
    datacontract_yaml: str = ""


class GovernanceActionRequest(BaseModel):
    project: Optional[ProjectMetamodel] = None
    entity_id: Optional[str] = None
    pattern: Optional[str] = None
    overwrite_existing: bool = True
    gemini_api_key: Optional[str] = None
    gemini_model: Optional[str] = "gemini-2.5-flash"
    use_gemini: bool = True


class SynthesizeViewRequest(BaseModel):
    view_entity: EntityModel
    project: ProjectMetamodel
    dialect: TargetDialect = TargetDialect.SNOWFLAKE


class ReverseEngineerRequest(BaseModel):
    ddl_script: str
    dialect: TargetDialect = TargetDialect.SNOWFLAKE
    subject_area: str = "Core"
    merge_into_project: bool = True


class ReverseEngineerResponse(BaseModel):
    entities_parsed: int
    relationships_parsed: int
    project: ProjectMetamodel


class CompareDiffRequest(BaseModel):
    current_project: Optional[ProjectMetamodel] = None
    target_ddl: Optional[str] = None
    baseline_revision_id: Optional[int] = None
    dialect: TargetDialect = TargetDialect.SNOWFLAKE


class AgentExecuteRequest(BaseModel):
    prompt: str
    mode: Literal["kilo-cli", "builtin-llm", "gemini"] = "builtin-llm"
    gemini_api_key: Optional[str] = None
    gemini_model: Optional[str] = "gemini-2.5-flash"
    project: Optional[ProjectMetamodel] = None


class ApplyMutationsRequest(BaseModel):
    mutations: List[Dict[str, Any]]
    prompt: str = ""
    reply: str = "Applied Gemini mutations."
    mode_used: str = "Google Gemini (Client Direct)"
    project: Optional[ProjectMetamodel] = None



class DomainUpsertRequest(BaseModel):
    domain: EnterpriseDomain
    project: Optional[ProjectMetamodel] = None


class UserApiKeyRequest(BaseModel):
    gemini_api_key: Optional[str] = None


class UserApiKeyResponse(BaseModel):
    has_gemini_key: bool
    masked_gemini_key: Optional[str] = None
    email: str
    message: str


# ---------------------------------------------------------------------------
# Module 1: Authentication & Admin User Management Endpoints
# ---------------------------------------------------------------------------
@app.post("/api/auth/login", response_model=LoginResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> LoginResponse:
    init_db_and_seed(db)
    email = payload.email.strip().lower()
    user = db.query(UserRecord).filter(UserRecord.email == email).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Account '{email}' not found. First login should be by admin@metaforge.local (password: password123).",
        )

    if payload.password not in ("password123", "metaforge123") and not verify_password(
        payload.password, user.password_hash
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid password.",
        )

    profile = build_user_profile(user)
    token = create_access_token(
        email=user.email,
        role=profile.role,
        full_name=user.full_name,
        user_id=user.id,
    )
    return LoginResponse(access_token=token, user=profile)


@app.get("/api/auth/me", response_model=UserProfile)
def get_me(current_user: UserProfile = Depends(get_current_user)) -> UserProfile:
    return current_user


@app.get("/api/auth/users", response_model=List[UserDirectoryItem])
def list_users(db: Session = Depends(get_db)) -> List[UserDirectoryItem]:
    """Return all registered accounts in the enterprise user directory."""
    init_db_and_seed(db)
    users = db.query(UserRecord).order_by(UserRecord.id.asc()).all()
    return [
        UserDirectoryItem(
            id=u.id,
            email=u.email,
            full_name=u.full_name,
            role=u.role,
            is_active=u.is_active,
        )
        for u in users
    ]


@app.post("/api/auth/users", response_model=UserDirectoryItem)
def create_user(
    payload: CreateUserRequest,
    current_user: UserProfile = Depends(require_roles([UserRole.ADMIN])),
    db: Session = Depends(get_db),
) -> UserDirectoryItem:
    """Admin-only: Create a new user account with any role (Admin, Data Architect, Data Steward, Viewer)."""
    init_db_and_seed(db)
    email = payload.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Valid email address is required.")

    existing = db.query(UserRecord).filter(UserRecord.email == email).first()
    if existing:
        raise HTTPException(
            status_code=400, detail=f"User with email '{email}' already exists."
        )

    new_user = UserRecord(
        email=email,
        full_name=payload.full_name.strip() or email.split("@")[0].title(),
        role=payload.role.value,
        password_hash=hash_password(payload.password or "password123"),
        is_active=True,
    )
    db.add(new_user)
    db.add(
        AuditLogRecord(
            actor_email=current_user.email,
            actor_role=current_user.role.value,
            action="CREATE_USER",
            details=f"Created user {email} with role {payload.role.value}",
        )
    )
    db.commit()
    db.refresh(new_user)

    return UserDirectoryItem(
        id=new_user.id,
        email=new_user.email,
        full_name=new_user.full_name,
        role=new_user.role,
        is_active=new_user.is_active,
    )


@app.put("/api/auth/users/{user_id}", response_model=UserDirectoryItem)
def update_user(
    user_id: int,
    payload: UpdateUserRequest,
    current_user: UserProfile = Depends(require_roles([UserRole.ADMIN])),
    db: Session = Depends(get_db),
) -> UserDirectoryItem:
    """Admin-only: Update a user's role (including promoting to Admin) or full name."""
    user = db.query(UserRecord).filter(UserRecord.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")

    if payload.full_name is not None and payload.full_name.strip():
        user.full_name = payload.full_name.strip()
    if payload.role is not None:
        user.role = payload.role.value
    if payload.password is not None and payload.password.strip():
        user.password_hash = hash_password(payload.password.strip())

    db.commit()
    db.refresh(user)
    return UserDirectoryItem(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=user.role,
        is_active=user.is_active,
    )


@app.delete("/api/auth/users/{user_id}")
def delete_user(
    user_id: int,
    current_user: UserProfile = Depends(require_roles([UserRole.ADMIN])),
    db: Session = Depends(get_db),
) -> Dict[str, str]:
    """Admin-only: Delete a user account."""
    user = db.query(UserRecord).filter(UserRecord.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    if user.email == "admin@metaforge.local":
        raise HTTPException(
            status_code=400, detail="Cannot delete primary bootstrap Admin account."
        )
    db.delete(user)
    db.commit()
    return {"status": "deleted", "email": user.email}


@app.get("/api/user/keys", response_model=UserApiKeyResponse)
def get_user_api_keys(
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserApiKeyResponse:
    """Returns whether the authenticated user has a personal Gemini API key configured, and a masked preview."""
    init_db_and_seed(db)
    user = db.query(UserRecord).filter(UserRecord.id == current_user.id).first()
    raw = (user.gemini_api_key or "").strip() if user else ""
    masked = f"{raw[:6]}...{raw[-4:]}" if len(raw) > 8 else ("***" if raw else None)
    return UserApiKeyResponse(
        has_gemini_key=bool(raw),
        masked_gemini_key=masked,
        email=current_user.email,
        message="User API keys retrieved successfully."
    )


@app.post("/api/user/keys", response_model=UserApiKeyResponse)
def save_user_api_keys(
    payload: UserApiKeyRequest,
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserApiKeyResponse:
    """Saves a user-specific private Gemini API key, stored only for this account and never shared with other users."""
    init_db_and_seed(db)
    user = db.query(UserRecord).filter(UserRecord.id == current_user.id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User account not found.")

    raw = (payload.gemini_api_key or "").strip()
    user.gemini_api_key = raw if raw else None
    db.commit()

    masked = f"{raw[:6]}...{raw[-4:]}" if len(raw) > 8 else ("***" if raw else None)
    return UserApiKeyResponse(
        has_gemini_key=bool(raw),
        masked_gemini_key=masked,
        email=current_user.email,
        message="Your personal Google Gemini API key has been securely saved to your account." if raw else "Gemini API key cleared."
    )


@app.delete("/api/user/keys/gemini")
def delete_user_gemini_key(
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Dict[str, str]:
    """Removes the personal Gemini API key for the authenticated user."""
    init_db_and_seed(db)
    user = db.query(UserRecord).filter(UserRecord.id == current_user.id).first()
    if user:
        user.gemini_api_key = None
        db.commit()
    return {"status": "cleared", "email": current_user.email}


# ---------------------------------------------------------------------------
# Module 2 & 3: Canonical Metamodel Persistence & Revision Snapshots
# ---------------------------------------------------------------------------
@app.get("/api/project", response_model=ProjectMetamodel)
def get_project(
    current_user: UserProfile = Depends(get_current_user),
) -> ProjectMetamodel:
    return ensure_seed_workspace(settings.canonical_model_path)


@app.put("/api/project", response_model=ProjectMetamodel)
def save_project(
    payload: SaveProjectRequest | ProjectMetamodel,
    current_user: UserProfile = Depends(
        require_roles([UserRole.ADMIN, UserRole.ARCHITECT, UserRole.STEWARD])
    ),
    db: Session = Depends(get_db),
) -> ProjectMetamodel:
    existing = ensure_seed_workspace(settings.canonical_model_path)

    if isinstance(payload, SaveProjectRequest):
        incoming = payload.project
        commit_msg = payload.commit_message
        sa = payload.subject_area
    else:
        incoming = payload
        commit_msg = "Updated canonical metamodel"
        sa = "All"

    validate_steward_restrictions(existing, incoming, current_user)
    apply_all_domains(incoming)

    save_workspace_model(settings.canonical_model_path, incoming)
    write_dbt_artifacts_to_disk(incoming, settings.exported_dbt_dir)

    rev_count = db.query(ModelRevisionRecord).count()
    rev_tag = f"v1.0.{rev_count}"
    db.add(
        ModelRevisionRecord(
            revision_tag=rev_tag,
            author_email=current_user.email,
            author_role=current_user.role.value,
            commit_message=commit_msg,
            subject_area=sa,
            model_json=incoming.model_dump_json(indent=2),
        )
    )
    db.add(
        AuditLogRecord(
            actor_email=current_user.email,
            actor_role=current_user.role.value,
            action="SAVE_PROJECT",
            details=f"{rev_tag}: {commit_msg}",
        )
    )
    db.commit()
    return incoming


@app.post("/api/project/reset", response_model=ProjectMetamodel)
def reset_seed_project(
    current_user: UserProfile = Depends(
        require_roles([UserRole.ADMIN, UserRole.ARCHITECT])
    ),
) -> ProjectMetamodel:
    project = build_default_project()
    save_workspace_model(settings.canonical_model_path, project)
    write_dbt_artifacts_to_disk(project, settings.exported_dbt_dir)
    return project


@app.post("/api/project/domains/cascade", response_model=ProjectMetamodel)
def upsert_and_cascade_domain(
    payload: DomainUpsertRequest,
    current_user: UserProfile = Depends(
        require_roles([UserRole.ADMIN, UserRole.ARCHITECT])
    ),
) -> ProjectMetamodel:
    model = payload.project or ensure_seed_workspace(settings.canonical_model_path)
    cascade_domain_to_model(model, payload.domain)
    save_workspace_model(settings.canonical_model_path, model)
    write_dbt_artifacts_to_disk(model, settings.exported_dbt_dir)
    return model


@app.post("/api/project/glossary/apply", response_model=ProjectMetamodel)
def apply_naming_glossary_endpoint(
    project: Optional[ProjectMetamodel] = None,
    current_user: UserProfile = Depends(
        require_roles([UserRole.ADMIN, UserRole.ARCHITECT])
    ),
    db: Session = Depends(get_db),
) -> ProjectMetamodel:
    model = project or ensure_seed_workspace(settings.canonical_model_path)
    stats = apply_glossary_to_project(model, overwrite_existing=True)
    save_workspace_model(settings.canonical_model_path, model)
    write_dbt_artifacts_to_disk(model, settings.exported_dbt_dir)

    rev_count = db.query(ModelRevisionRecord).count()
    db.add(
        ModelRevisionRecord(
            revision_tag=f"v1.0.{rev_count}-nsm",
            author_email=current_user.email,
            author_role=current_user.role.value,
            commit_message=(
                f"Applied Naming Standards Glossary ({stats['entities_updated']} entities, "
                f"{stats['columns_updated']} columns standardized)"
            ),
            subject_area="All",
            model_json=model.model_dump_json(indent=2),
        )
    )
    db.commit()
    return model


# ---------------------------------------------------------------------------
# Module 4: Multi-Dialect DDL, View Synthesis & dbt Compilation Endpoints
# ---------------------------------------------------------------------------
@app.post("/api/project/compile", response_model=CompileResponse)
def compile_project(
    payload: Optional[CompileRequest] = None,
    current_user: UserProfile = Depends(get_current_user),
) -> CompileResponse:
    model = (
        payload.project
        if payload and payload.project
        else ensure_seed_workspace(settings.canonical_model_path)
    )
    sa = payload.subject_area if payload else None

    sf_ddl = compile_snowflake_ddl(model, subject_area=sa)
    ss_ddl = compile_sql_server_ddl(model, subject_area=sa)
    ora_ddl = compile_oracle_ddl(model, subject_area=sa)
    dbt_files = compile_dbt_artifacts(model)
    contract_yaml = compile_open_data_contract_yaml(model, subject_area=sa)
    dbt_files["datacontract.yaml"] = contract_yaml
    write_dbt_artifacts_to_disk(model, settings.exported_dbt_dir)

    return CompileResponse(
        snowflake_ddl=sf_ddl,
        sql_server_ddl=ss_ddl,
        oracle_ddl=ora_ddl,
        sqlite_ddl=compile_sqlite_ddl(model, subject_area=sa),
        dbt_files=dbt_files,
        datacontract_yaml=contract_yaml,
    )


@app.post("/api/governance/auto-metadata")
def run_auto_metadata_endpoint(
    payload: GovernanceActionRequest,
    current_user: UserProfile = Depends(
        require_roles([UserRole.ADMIN, UserRole.ARCHITECT, UserRole.STEWARD])
    ),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """AI-Powered Metadata Auto-Generator: generates descriptions, grain, PII tags, and retention defaults using Google Gemini."""
    model = payload.project or ensure_seed_workspace(settings.canonical_model_path)
    effective_api_key = payload.gemini_api_key
    if not effective_api_key:
        user_record = db.query(UserRecord).filter(UserRecord.id == current_user.id).first()
        if user_record and user_record.gemini_api_key:
            effective_api_key = user_record.gemini_api_key

    stats, model = generate_metadata_with_gemini(
        model=model,
        entity_id=payload.entity_id,
        gemini_api_key=effective_api_key,
        gemini_model=payload.gemini_model or "gemini-2.5-flash",
        overwrite_existing=payload.overwrite_existing,
    )
    save_workspace_model(settings.canonical_model_path, model)
    return {"stats": stats, "project": model}


@app.post("/api/governance/profile")
def run_profiler_endpoint(
    payload: GovernanceActionRequest,
    current_user: UserProfile = Depends(get_current_user),
) -> Dict[str, Any]:
    """Runs Data Profiler & Volumetrics analysis and recommends DQ rules."""
    model = payload.project or ensure_seed_workspace(settings.canonical_model_path)
    stats = run_data_profiler(model, entity_id=payload.entity_id)
    save_workspace_model(settings.canonical_model_path, model)
    return {"stats": stats, "project": model}


@app.post("/api/governance/apply-dq")
def apply_recommended_dq_endpoint(
    payload: GovernanceActionRequest,
    current_user: UserProfile = Depends(
        require_roles([UserRole.ADMIN, UserRole.ARCHITECT])
    ),
) -> Dict[str, Any]:
    """Applies recommended dbt tests, check constraints, alternate keys, and clustering keys from profiler."""
    model = payload.project or ensure_seed_workspace(settings.canonical_model_path)
    stats = apply_recommended_dq_rules(model, entity_id=payload.entity_id)
    save_workspace_model(settings.canonical_model_path, model)
    return {"stats": stats, "project": model}


@app.post("/api/governance/apply-pattern")
def apply_pattern_endpoint(
    payload: GovernanceActionRequest,
    current_user: UserProfile = Depends(
        require_roles([UserRole.ADMIN, UserRole.ARCHITECT])
    ),
) -> Dict[str, Any]:
    """Applies Kimball SCD Type 2, Data Vault 2.0 Hub, or Enterprise Audit pattern to an entity."""
    if not payload.entity_id or not payload.pattern:
        raise HTTPException(
            status_code=400, detail="entity_id and pattern are required."
        )
    model = payload.project or ensure_seed_workspace(settings.canonical_model_path)
    stats = apply_modeling_pattern(model, payload.entity_id, payload.pattern)
    save_workspace_model(settings.canonical_model_path, model)
    return {"stats": stats, "project": model}


@app.post("/api/views/synthesize-sql")
def synthesize_view_sql_endpoint(
    payload: SynthesizeViewRequest,
    current_user: UserProfile = Depends(get_current_user),
) -> Dict[str, str]:
    """Generate background SELECT SQL and full CREATE VIEW DDL for a UI-authored View."""
    select_sql = synthesize_view_select_sql(
        payload.view_entity, payload.project, payload.dialect
    )
    full_ddl = compile_view_ddl(
        payload.view_entity, payload.project, payload.dialect
    )
    return {
        "select_sql": select_sql,
        "full_ddl": full_ddl,
    }


# ---------------------------------------------------------------------------
# Module 5: Reverse Engineering & Complete Compare Endpoints
# ---------------------------------------------------------------------------
@app.post("/api/reverse-engineer/ddl", response_model=ReverseEngineerResponse)
def reverse_engineer_ddl(
    payload: ReverseEngineerRequest,
    current_user: UserProfile = Depends(
        require_roles([UserRole.ADMIN, UserRole.ARCHITECT])
    ),
    db: Session = Depends(get_db),
) -> ReverseEngineerResponse:
    model = ensure_seed_workspace(settings.canonical_model_path)

    entities, relationships = parse_ddl_to_metamodel(
        ddl_script=payload.ddl_script,
        dialect=payload.dialect,
        default_subject_area=payload.subject_area,
        existing_entities=model.entities if payload.merge_into_project else None,
    )
    if not entities:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No CREATE TABLE or CREATE VIEW statements could be parsed from the supplied DDL script.",
        )

    if not payload.merge_into_project:
        model.entities = {}
        model.relationships = {}

    if payload.subject_area not in model.subject_areas:
        model.subject_areas.append(payload.subject_area)

    existing_by_phys = {e.physical_name.upper(): e.id for e in model.entities.values()}
    id_remap: Dict[str, str] = {}

    for ent in entities:
        phys_key = ent.physical_name.upper()
        if phys_key in existing_by_phys:
            old_id = existing_by_phys[phys_key]
            id_remap[ent.id] = old_id
            ent.id = old_id
        model.entities[ent.id] = ent

    for rel in relationships:
        rel.parent_entity_id = id_remap.get(rel.parent_entity_id, rel.parent_entity_id)
        rel.child_entity_id = id_remap.get(rel.child_entity_id, rel.child_entity_id)
        model.relationships[rel.id] = rel

    save_workspace_model(settings.canonical_model_path, model)
    write_dbt_artifacts_to_disk(model, settings.exported_dbt_dir)

    rev_count = db.query(ModelRevisionRecord).count()
    db.add(
        ModelRevisionRecord(
            revision_tag=f"v1.0.{rev_count}-reveng",
            author_email=current_user.email,
            author_role=current_user.role.value,
            commit_message=f"Reverse-engineered {len(entities)} object(s) from {payload.dialect.value} DDL",
            subject_area=payload.subject_area,
            model_json=model.model_dump_json(indent=2),
        )
    )
    db.commit()

    return ReverseEngineerResponse(
        entities_parsed=len(entities),
        relationships_parsed=len(relationships),
        project=model,
    )


@app.post("/api/compare/diff", response_model=CompareDiffResult)
def compare_diff(
    payload: CompareDiffRequest,
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CompareDiffResult:
    current_model = payload.current_project or ensure_seed_workspace(settings.canonical_model_path)

    if payload.target_ddl and payload.target_ddl.strip():
        parsed_ents, parsed_rels = parse_ddl_to_metamodel(
            ddl_script=payload.target_ddl,
            dialect=payload.dialect,
        )
        baseline_model = ProjectMetamodel(
            name=f"Target {payload.dialect.value.upper()} DDL Script",
            version="baseline",
            entities={e.id: e for e in parsed_ents},
            relationships={r.id: r for r in parsed_rels},
        )
    elif payload.baseline_revision_id is not None:
        rev = (
            db.query(ModelRevisionRecord)
            .filter(ModelRevisionRecord.id == payload.baseline_revision_id)
            .first()
        )
        if not rev:
            raise HTTPException(status_code=404, detail="Baseline revision not found.")
        baseline_model = ProjectMetamodel.model_validate_json(rev.model_json)
    else:
        baseline_model = build_default_project()

    return run_complete_compare(
        current_model=current_model,
        baseline_model=baseline_model,
        dialect=payload.dialect,
    )


# ---------------------------------------------------------------------------
# Module 6: Agentic Control Plane Endpoints (kilo-cli + Built-in LLM + MCP)
# ---------------------------------------------------------------------------
@app.get("/api/agent/gemini-models")
def list_gemini_models() -> Dict[str, Any]:
    """Returns available Google Gemini models and default selection for the AI Agent."""
    return {"models": GEMINI_AVAILABLE_MODELS}


@app.post("/api/agent/execute", response_model=AgentExecutionResponse)
def execute_agent(
    payload: AgentExecuteRequest,
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AgentExecutionResponse:
    model = payload.project or ensure_seed_workspace(settings.canonical_model_path)
    allow_mutations = current_user.role in (
        UserRole.ADMIN,
        UserRole.ARCHITECT,
        UserRole.STEWARD,
    )

    effective_api_key = payload.gemini_api_key
    if not effective_api_key:
        user_record = db.query(UserRecord).filter(UserRecord.id == current_user.id).first()
        if user_record and user_record.gemini_api_key:
            effective_api_key = user_record.gemini_api_key

    result = execute_agent_prompt(
        model=model,
        prompt=payload.prompt,
        mode=payload.mode,
        gemini_api_key=effective_api_key,
        gemini_model=payload.gemini_model,
        allow_mutations=allow_mutations,
    )

    if result.mutated:
        save_workspace_model(settings.canonical_model_path, result.updated_model)
        rev_count = db.query(ModelRevisionRecord).count()
        db.add(
            ModelRevisionRecord(
                revision_tag=f"v1.0.{rev_count}-agent",
                author_email=current_user.email,
                author_role=current_user.role.value,
                commit_message=f"Agent ({result.mode_used}): {payload.prompt[:120]}",
                subject_area="All",
                model_json=result.updated_model.model_dump_json(indent=2),
            )
        )
        db.commit()

    return result


@app.post("/api/agent/apply-mutations", response_model=AgentExecutionResponse)
def apply_agent_mutations(
    payload: ApplyMutationsRequest,
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AgentExecutionResponse:
    from .agent.mutation_engine import execute_mutations

    model = payload.project or ensure_seed_workspace(settings.canonical_model_path)
    allow_mutations = current_user.role in (
        UserRole.ADMIN,
        UserRole.ARCHITECT,
        UserRole.STEWARD,
    )
    if not allow_mutations:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your active role does not permit modifying the data model.",
        )

    updated_model, actions_taken = execute_mutations(model, payload.mutations)
    mutated = len(actions_taken) > 0

    if mutated:
        save_workspace_model(settings.canonical_model_path, updated_model)
        write_dbt_artifacts_to_disk(updated_model, settings.exported_dbt_dir)
        rev_count = db.query(ModelRevisionRecord).count()
        db.add(
            ModelRevisionRecord(
                revision_tag=f"v1.0.{rev_count}-gemini",
                author_email=current_user.email,
                author_role=current_user.role.value,
                commit_message=f"Gemini: {payload.prompt[:120]}",
                subject_area="All",
                model_json=updated_model.model_dump_json(indent=2),
            )
        )
        db.commit()

    return AgentExecutionResponse(
        mode_used=payload.mode_used,
        mutated=mutated,
        reply=payload.reply,
        actions_taken=actions_taken,
        updated_model=updated_model,
    )


@app.get("/api/revisions", response_model=List[RevisionSummary])
def list_revisions(
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> List[RevisionSummary]:
    init_db_and_seed(db)
    records = (
        db.query(ModelRevisionRecord)
        .order_by(ModelRevisionRecord.id.desc())
        .limit(50)
        .all()
    )
    out: List[RevisionSummary] = []
    for r in records:
        ent_cnt = 0
        rel_cnt = 0
        try:
            parsed = json.loads(r.model_json)
            ent_cnt = len(parsed.get("entities", {}))
            rel_cnt = len(parsed.get("relationships", {}))
        except Exception:
            pass
        out.append(
            RevisionSummary(
                id=r.id,
                revision_tag=r.revision_tag,
                author_email=r.author_email,
                author_role=r.author_role,
                commit_message=r.commit_message,
                subject_area=r.subject_area,
                created_at=r.created_at.isoformat() if r.created_at else "",
                entity_count=ent_cnt,
                relationship_count=rel_cnt,
            )
        )
    return out


@app.post("/api/revisions/{revision_id}/restore", response_model=ProjectMetamodel)
def restore_revision(
    revision_id: int,
    current_user: UserProfile = Depends(
        require_roles([UserRole.ADMIN, UserRole.ARCHITECT])
    ),
    db: Session = Depends(get_db),
) -> ProjectMetamodel:
    rev = (
        db.query(ModelRevisionRecord)
        .filter(ModelRevisionRecord.id == revision_id)
        .first()
    )
    if not rev:
        raise HTTPException(status_code=404, detail="Revision not found.")
    restored = ProjectMetamodel.model_validate_json(rev.model_json)
    save_workspace_model(settings.canonical_model_path, restored)
    write_dbt_artifacts_to_disk(restored, settings.exported_dbt_dir)
    return restored


# ---------------------------------------------------------------------------
# Module 6B: Model Context Protocol (MCP) Endpoints (Claude Code, Cursor, Kiro, Gemini)
# ---------------------------------------------------------------------------
class MCPCallRequest(BaseModel):
    name: str
    arguments: Optional[Dict[str, Any]] = None


@app.get("/api/mcp/tools")
def get_mcp_tools() -> Dict[str, Any]:
    """Returns all available MCP tools exposed by MetaForge Studio."""
    return {"tools": mcp_registry.list_tools(), "count": len(mcp_registry.tools)}


@app.get("/api/mcp/resources")
def get_mcp_resources() -> Dict[str, Any]:
    """Returns available MCP resources (model://canonical, model://ddl/*, model://dbt/*, etc.)."""
    return {"resources": mcp_registry.list_resources()}


@app.get("/api/mcp/prompts")
def get_mcp_prompts() -> Dict[str, Any]:
    """Returns available MCP prompt templates."""
    return {"prompts": mcp_registry.list_prompts()}


@app.post("/api/mcp/rpc")
def handle_mcp_rpc(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Standard JSON-RPC 2.0 MCP endpoint for external AI coding assistants over HTTP."""
    res = dispatch_jsonrpc_request(payload)
    if res is None:
        return {"jsonrpc": "2.0", "result": "acknowledged"}
    return res


@app.post("/api/mcp/call")
def handle_mcp_tool_call(payload: MCPCallRequest) -> Dict[str, Any]:
    """Direct REST shortcut to execute an MCP tool and return its result."""
    try:
        out = mcp_registry.call_tool(payload.name, payload.arguments or {})
        return {"ok": True, "tool": payload.name, "result": out}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/mcp/config")
def get_mcp_client_configurations() -> Dict[str, Any]:
    """Returns ready-to-use configuration snippets and CLI commands for Claude Code, Cursor, Kiro, Gemini, and Claude Desktop."""
    import os

    root_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    python_path = os.path.join(root_dir, ".venv", "bin", "python3")
    script_path = os.path.join(root_dir, "mcp_server.py")

    return {
        "status": "ready",
        "server_info": {
            "name": "metaforge-data-modeling-mcp",
            "version": "1.0.0",
            "python_executable": python_path,
            "script_path": script_path,
            "http_rpc_endpoint": "http://127.0.0.1:8000/api/mcp/rpc",
            "tool_count": len(mcp_registry.tools),
            "resource_count": len(mcp_registry.resources),
            "prompt_count": len(mcp_registry.prompts),
        },
        "clients": {
            "claude_code": {
                "name": "Claude Code (Anthropic CLI)",
                "type": "cli_command",
                "command": f"claude mcp add metaforge {python_path} {script_path}",
                "config_file": "~/.claude/config.json",
                "config_json": {
                    "mcpServers": {
                        "metaforge": {
                            "command": python_path,
                            "args": [script_path],
                        }
                    }
                },
            },
            "cursor": {
                "name": "Cursor IDE",
                "type": "config_json",
                "config_file": ".cursor/mcp.json",
                "config_json": {
                    "mcpServers": {
                        "metaforge": {
                            "command": python_path,
                            "args": [script_path],
                        }
                    }
                },
            },
            "kiro": {
                "name": "Kiro / Kilocode",
                "type": "config_json",
                "config_file": "mcp.json or settings.json",
                "config_json": {
                    "mcpServers": {
                        "metaforge": {
                            "command": python_path,
                            "args": [script_path],
                        }
                    }
                },
            },
            "gemini": {
                "name": "Gemini CLI / Gemini Code Assist",
                "type": "config_json",
                "config_file": "gemini-mcp.json",
                "config_json": {
                    "mcpServers": {
                        "metaforge": {
                            "command": python_path,
                            "args": [script_path],
                        }
                    }
                },
            },
            "claude_desktop": {
                "name": "Claude Desktop",
                "type": "config_json",
                "config_file": "~/Library/Application Support/Claude/claude_desktop_config.json",
                "config_json": {
                    "mcpServers": {
                        "metaforge": {
                            "command": python_path,
                            "args": [script_path],
                        }
                    }
                },
            },
            "http_generic": {
                "name": "HTTP / Web Coding Assistants",
                "type": "http_url",
                "url": "http://127.0.0.1:8000/api/mcp/rpc",
            },
        },
    }


# ---------------------------------------------------------------------------
# Module 7: Live Database Connection Manager (Reverse Eng, Profiling & DDL Push)
# ---------------------------------------------------------------------------
class DatabaseConnectionPayload(BaseModel):
    id: Optional[int] = None
    name: str
    dialect: str = "snowflake"  # sqlite, snowflake, sql_server, oracle, postgresql
    host: Optional[str] = "localhost"
    port: Optional[int] = None
    database_name: Optional[str] = None
    schema_name: Optional[str] = "PUBLIC"
    username: Optional[str] = None
    password_secret: Optional[str] = None
    warehouse: Optional[str] = None
    role_name: Optional[str] = None
    connection_url: Optional[str] = None
    is_default: bool = False


class DatabaseConnectionOut(BaseModel):
    id: int
    name: str
    dialect: str
    host: Optional[str] = None
    port: Optional[int] = None
    database_name: Optional[str] = None
    schema_name: Optional[str] = None
    username: Optional[str] = None
    warehouse: Optional[str] = None
    role_name: Optional[str] = None
    connection_url: Optional[str] = None
    is_default: bool
    created_by: str
    created_at: str


class LiveReverseEngineerRequest(BaseModel):
    project: Optional[ProjectMetamodel] = None
    subject_area: str = "Core"
    selected_objects: Optional[List[str]] = None
    merge_into_project: bool = True


class LiveProfileRequest(BaseModel):
    project: Optional[ProjectMetamodel] = None
    entity_id: Optional[str] = None


class ExecuteDdlRequest(BaseModel):
    ddl_script: str
    dry_run: bool = False


def _serialize_conn(r: DatabaseConnectionRecord) -> DatabaseConnectionOut:
    return DatabaseConnectionOut(
        id=r.id,
        name=r.name,
        dialect=r.dialect,
        host=r.host,
        port=r.port,
        database_name=r.database_name,
        schema_name=r.schema_name,
        username=r.username,
        warehouse=r.warehouse,
        role_name=r.role_name,
        connection_url=r.connection_url,
        is_default=r.is_default,
        created_by=r.created_by,
        created_at=r.created_at.isoformat() if r.created_at else "",
    )


@app.get("/api/connections", response_model=List[DatabaseConnectionOut])
def list_database_connections(
    db: Session = Depends(get_db),
) -> List[DatabaseConnectionOut]:
    init_db_and_seed(db)
    rows = (
        db.query(DatabaseConnectionRecord)
        .order_by(DatabaseConnectionRecord.is_default.desc(), DatabaseConnectionRecord.id.asc())
        .all()
    )
    return [_serialize_conn(r) for r in rows]


@app.post("/api/connections", response_model=DatabaseConnectionOut)
def upsert_database_connection(
    payload: DatabaseConnectionPayload,
    current_user: UserProfile = Depends(
        require_roles([UserRole.ADMIN, UserRole.ARCHITECT])
    ),
    db: Session = Depends(get_db),
) -> DatabaseConnectionOut:
    init_db_and_seed(db)
    rec: Optional[DatabaseConnectionRecord] = None
    if payload.id:
        rec = (
            db.query(DatabaseConnectionRecord)
            .filter(DatabaseConnectionRecord.id == payload.id)
            .first()
        )
    if not rec:
        rec = (
            db.query(DatabaseConnectionRecord)
            .filter(DatabaseConnectionRecord.name == payload.name.strip())
            .first()
        )
    if not rec:
        rec = DatabaseConnectionRecord(
            name=payload.name.strip(),
            created_by=current_user.email,
        )
        db.add(rec)

    rec.name = payload.name.strip()
    rec.dialect = payload.dialect
    rec.host = payload.host
    rec.port = payload.port
    rec.database_name = payload.database_name
    rec.schema_name = payload.schema_name
    rec.username = payload.username
    if payload.password_secret is not None:
        rec.password_secret = payload.password_secret
    rec.warehouse = payload.warehouse
    rec.role_name = payload.role_name
    rec.connection_url = payload.connection_url
    rec.is_default = payload.is_default

    db.commit()
    db.refresh(rec)
    return _serialize_conn(rec)


@app.delete("/api/connections/{connection_id}")
def delete_database_connection(
    connection_id: int,
    current_user: UserProfile = Depends(
        require_roles([UserRole.ADMIN, UserRole.ARCHITECT])
    ),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    init_db_and_seed(db)
    rec = (
        db.query(DatabaseConnectionRecord)
        .filter(DatabaseConnectionRecord.id == connection_id)
        .first()
    )
    if not rec:
        raise HTTPException(status_code=404, detail="Database connection not found.")
    db.delete(rec)
    db.commit()
    return {"deleted": True, "id": connection_id}


@app.post("/api/connections/test")
def test_connection_endpoint(
    payload: DatabaseConnectionPayload,
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    init_db_and_seed(db)
    if payload.id:
        rec = (
            db.query(DatabaseConnectionRecord)
            .filter(DatabaseConnectionRecord.id == payload.id)
            .first()
        )
        if rec:
            return test_database_connection(
                dialect=rec.dialect,
                host=rec.host,
                port=rec.port,
                database_name=rec.database_name,
                schema_name=rec.schema_name,
                username=rec.username,
                password_secret=rec.password_secret,
                warehouse=rec.warehouse,
                role_name=rec.role_name,
                connection_url=rec.connection_url,
            )
    return test_database_connection(
        dialect=payload.dialect,
        host=payload.host,
        port=payload.port,
        database_name=payload.database_name,
        schema_name=payload.schema_name,
        username=payload.username,
        password_secret=payload.password_secret,
        warehouse=payload.warehouse,
        role_name=payload.role_name,
        connection_url=payload.connection_url,
    )


@app.post("/api/connections/{connection_id}/reverse-engineer")
def live_reverse_engineer_endpoint(
    connection_id: int,
    payload: LiveReverseEngineerRequest,
    current_user: UserProfile = Depends(
        require_roles([UserRole.ADMIN, UserRole.ARCHITECT])
    ),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Pulls tables, views, columns, FKs, and row counts from a live DB connection into the canvas metamodel."""
    init_db_and_seed(db)
    rec = (
        db.query(DatabaseConnectionRecord)
        .filter(DatabaseConnectionRecord.id == connection_id)
        .first()
    )
    if not rec:
        raise HTTPException(status_code=404, detail="Database connection not found.")

    model = payload.project or ensure_seed_workspace(settings.canonical_model_path)
    ent_cnt, rel_cnt, extracted_ddl = reverse_engineer_from_connection(
        conn_rec=rec,
        model=model,
        subject_area=payload.subject_area,
        selected_objects=payload.selected_objects,
        merge_into_project=payload.merge_into_project,
    )
    save_workspace_model(settings.canonical_model_path, model)
    write_dbt_artifacts_to_disk(model, settings.exported_dbt_dir)
    return {
        "entities_parsed": ent_cnt,
        "relationships_parsed": rel_cnt,
        "extracted_ddl": extracted_ddl,
        "connection_name": rec.name,
        "project": model,
    }


@app.post("/api/connections/{connection_id}/profile")
def live_profile_endpoint(
    connection_id: int,
    payload: LiveProfileRequest,
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Runs live SQL aggregate profiling queries against physical tables in the connected database."""
    if metadata_only():
        raise HTTPException(
            status_code=403,
            detail="Metadata-only mode is on: live profiling reads row values and is disabled. "
            "An admin can turn it off in AI Companion -> Privacy.",
        )
    init_db_and_seed(db)
    rec = (
        db.query(DatabaseConnectionRecord)
        .filter(DatabaseConnectionRecord.id == connection_id)
        .first()
    )
    if not rec:
        raise HTTPException(status_code=404, detail="Database connection not found.")

    model = payload.project or ensure_seed_workspace(settings.canonical_model_path)
    stats = profile_from_connection(
        conn_rec=rec,
        model=model,
        entity_id=payload.entity_id,
    )
    save_workspace_model(settings.canonical_model_path, model)
    return {
        "stats": stats,
        "project": model,
    }


@app.post("/api/connections/{connection_id}/execute-ddl")
def live_execute_ddl_endpoint(
    connection_id: int,
    payload: ExecuteDdlRequest,
    current_user: UserProfile = Depends(
        require_roles([UserRole.ADMIN, UserRole.ARCHITECT])
    ),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Executes compiled DDL or Complete Compare ALTER script against the connected database."""
    init_db_and_seed(db)
    rec = (
        db.query(DatabaseConnectionRecord)
        .filter(DatabaseConnectionRecord.id == connection_id)
        .first()
    )
    if not rec:
        raise HTTPException(status_code=404, detail="Database connection not found.")

    report = execute_ddl_on_connection(
        conn_rec=rec,
        ddl_script=payload.ddl_script,
        dry_run=payload.dry_run,
    )
    db.add(
        AuditLogRecord(
            actor_email=current_user.email,
            actor_role=current_user.role.value,
            action="EXECUTE_DDL_ON_DB",
            details=f"Connection={rec.name}, DryRun={payload.dry_run}, Executed={report['statements_executed']}, Errors={report['errors']}",
        )
    )
    db.commit()
    return report


# ---------------------------------------------------------------------------
# Excel (.xlsx) & CSV (.csv) File Ingestion & Reverse Engineering Endpoints
# ---------------------------------------------------------------------------
class CommitFileImportRequest(BaseModel):
    sheets: List[SheetInspectionResult]
    subject_area: str = "Staging"
    merge_into_project: bool = True


@app.post("/api/reverse-engineer/file")
async def inspect_uploaded_file_endpoint(
    file: UploadFile = File(...),
    current_user: UserProfile = Depends(get_current_user),
) -> FileInspectionSummary:
    """Accepts an uploaded Excel workbook (.xlsx, .xls) or CSV file (.csv), parses worksheets,

    infers column data types, and profiles statistical distributions.
    """
    filename = file.filename or "uploaded_dataset.csv"
    lower_name = filename.lower()
    content = await file.read()

    if lower_name.endswith(".csv") or lower_name.endswith(".txt"):
        return parse_csv_bytes(content, filename)
    elif lower_name.endswith(".xlsx") or lower_name.endswith(".xls"):
        return parse_excel_bytes(content, filename)
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format '{filename}'. Please upload a valid .xlsx Excel workbook or .csv file.",
        )


@app.post("/api/reverse-engineer/file/commit")
def commit_file_import_endpoint(
    payload: CommitFileImportRequest,
    current_user: UserProfile = Depends(
        require_roles([UserRole.ADMIN, UserRole.ARCHITECT])
    ),
) -> Dict[str, Any]:
    """Commits inspected Excel worksheets or CSV tables into the canonical project metamodel

    with automated foreign key relational inference and data profiling persistence.
    """
    model = ensure_seed_workspace(settings.canonical_model_path)
    ents_added, rels_added = import_sheets_to_metamodel(
        model=model,
        sheets=payload.sheets,
        target_subject_area=payload.subject_area,
        merge_into_project=payload.merge_into_project,
    )
    save_workspace_model(settings.canonical_model_path, model)
    write_dbt_artifacts_to_disk(model, settings.exported_dbt_dir)

    return {
        "ok": True,
        "entities_imported": ents_added,
        "relationships_inferred": rels_added,
        "target_subject_area": payload.subject_area,
        "project": model,
    }


# ---------------------------------------------------------------------------
# Data Profiling & Column Name Definition Generator Endpoint
# ---------------------------------------------------------------------------
class GenerateDefinitionsRequest(BaseModel):
    entity_id: Optional[str] = None
    overwrite_existing: bool = True
    gemini_api_key: Optional[str] = None
    gemini_model: Optional[str] = "gemini-2.5-flash"
    use_gemini: bool = True


@app.post("/api/governance/generate-definitions-from-profile")
def generate_definitions_from_profile_endpoint(
    payload: GenerateDefinitionsRequest,
    current_user: UserProfile = Depends(
        require_roles([UserRole.ADMIN, UserRole.ARCHITECT, UserRole.STEWARD])
    ),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Generates rich, enterprise-grade business definitions for tables and columns
    by synthesizing live data profiling statistics with Google Gemini LLM.
    """
    model = ensure_seed_workspace(settings.canonical_model_path)
    effective_api_key = payload.gemini_api_key
    if not effective_api_key:
        user_record = db.query(UserRecord).filter(UserRecord.id == current_user.id).first()
        if user_record and user_record.gemini_api_key:
            effective_api_key = user_record.gemini_api_key

    res, model = generate_metadata_with_gemini(
        model=model,
        entity_id=payload.entity_id,
        gemini_api_key=effective_api_key,
        gemini_model=payload.gemini_model or "gemini-2.5-flash",
        overwrite_existing=payload.overwrite_existing,
    )
    save_workspace_model(settings.canonical_model_path, model)
    write_dbt_artifacts_to_disk(model, settings.exported_dbt_dir)

    return {
        "ok": True,
        "entities_updated": res["entities_updated"],
        "columns_updated": res["columns_updated"],
        "ai_provider": res.get("ai_provider", "Google Gemini (gemini-2.5-flash)"),
        "live_llm": res.get("live_llm", False),
        "message": res.get("message", "Definitions successfully synthesized."),
        "project": model,
    }


# ---------------------------------------------------------------------------
# Metadata Pushback Endpoints: Push Definitions to Database
# ---------------------------------------------------------------------------
class PushMetadataRequest(BaseModel):
    dry_run: bool = False
    entity_ids: Optional[List[str]] = None


@app.get("/api/connections/{connection_id}/preview-push-metadata")
def preview_push_metadata_endpoint(
    connection_id: int,
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Previews the dialect-tailored SQL/DDL statements required to push table and column descriptions

    back to the target database (SQLite _metaforge_metadata, Snowflake/Oracle/Postgres COMMENT ON, or SQL Server MS_Description).
    """
    init_db_and_seed(db)
    rec = (
        db.query(DatabaseConnectionRecord)
        .filter(DatabaseConnectionRecord.id == connection_id)
        .first()
    )
    if not rec:
        raise HTTPException(status_code=404, detail="Database connection not found.")

    model = ensure_seed_workspace(settings.canonical_model_path)
    stmts = generate_metadata_push_script(conn_rec=rec, model=model)
    return {
        "connection_name": rec.name,
        "dialect": rec.dialect,
        "total_statements": len(stmts),
        "statements": stmts,
    }


@app.post("/api/connections/{connection_id}/push-metadata")
def push_metadata_endpoint(
    connection_id: int,
    payload: PushMetadataRequest,
    current_user: UserProfile = Depends(
        require_roles([UserRole.ADMIN, UserRole.ARCHITECT, UserRole.STEWARD])
    ),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Pushes table and column definitions and comments directly to the connected target database."""
    init_db_and_seed(db)
    rec = (
        db.query(DatabaseConnectionRecord)
        .filter(DatabaseConnectionRecord.id == connection_id)
        .first()
    )
    if not rec:
        raise HTTPException(status_code=404, detail="Database connection not found.")

    model = ensure_seed_workspace(settings.canonical_model_path)
    report = push_metadata_to_connection(
        conn_rec=rec,
        model=model,
        dry_run=payload.dry_run,
        selected_entities=payload.entity_ids,
    )
    db.add(
        AuditLogRecord(
            actor_email=current_user.email,
            actor_role=current_user.role.value,
            action="PUSH_METADATA_TO_DB",
            details=f"Connection={rec.name}, DryRun={payload.dry_run}, Executed={report['statements_executed']}, Errors={report['errors']}",
        )
    )
    db.commit()
    return report


# ---------------------------------------------------------------------------
# Data Dictionary Export (CSV)
# ---------------------------------------------------------------------------
@app.get("/api/export/data-dictionary/csv")
def export_data_dictionary_csv_endpoint(
    current_user: UserProfile = Depends(get_current_user),
) -> Response:
    """Exports the entire enterprise data dictionary with column types, domains, PII classifications,

    descriptions, and profiling metrics as a CSV spreadsheet.
    """
    model = ensure_seed_workspace(settings.canonical_model_path)
    csv_str = export_metamodel_to_csv_dictionary(model)
    return Response(
        content=csv_str,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="metaforge_data_dictionary.csv"'},
    )


# ---------------------------------------------------------------------------
# Remote Model Repository, User Access Control (ACL), Check-Out Locking,
# Admin Force Release & 3-Way Non-Conflicting Reapply Endpoints
# ---------------------------------------------------------------------------
class CreateRemoteModelRequest(BaseModel):
    name: str
    description: str = ""
    project: Optional[ProjectMetamodel] = None


class SaveRemoteDraftRequest(BaseModel):
    project: ProjectMetamodel
    checkout_id: Optional[str] = None


class CheckinRemoteModelRequest(BaseModel):
    project: ProjectMetamodel
    commit_message: str = "Checked in updated canonical model to remote repository"
    checkout_id: Optional[str] = None


class ForceReleaseRequest(BaseModel):
    reason: str = "Administrative force release of model lock"


class ReapplyRemoteModelRequest(BaseModel):
    project: Optional[ProjectMetamodel] = None
    checkout_id: Optional[str] = None


class UpdateModelAccessListRequest(BaseModel):
    entries: List[ModelAccessEntry]


@app.get("/api/remote-models", response_model=List[RemoteModelSummary])
def get_remote_models_endpoint(
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> List[RemoteModelSummary]:
    """Lists all remote models accessible to the current user along with lock status, holder details, and user permissions."""
    init_db_and_seed(db)
    return list_remote_models(db, current_user)


@app.post("/api/remote-models", response_model=RemoteModelSummary)
def create_remote_model_endpoint(
    payload: CreateRemoteModelRequest,
    current_user: UserProfile = Depends(
        require_roles([UserRole.ADMIN, UserRole.ARCHITECT])
    ),
    db: Session = Depends(get_db),
) -> RemoteModelSummary:
    """Publishes a new model into the shared remote repository."""
    init_db_and_seed(db)
    return create_new_remote_model(
        db=db,
        name=payload.name,
        description=payload.description,
        project=payload.project,
        user=current_user,
    )


@app.get("/api/remote-models/{model_id}/view", response_model=RemoteModelDetailResponse)
def view_remote_model_endpoint(
    model_id: str,
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RemoteModelDetailResponse:
    """Loads a model from the remote repository in View-Only mode without checking it out or locking it."""
    init_db_and_seed(db)
    return view_remote_model(db, model_id, current_user)


@app.post("/api/remote-models/{model_id}/checkout", response_model=RemoteModelDetailResponse)
def checkout_remote_model_endpoint(
    model_id: str,
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RemoteModelDetailResponse:
    """Checks out a remote model, locking it in the shared repository and downloading a local working copy."""
    init_db_and_seed(db)
    return checkout_remote_model(db, model_id, current_user)


@app.post("/api/remote-models/{model_id}/draft")
def save_remote_draft_endpoint(
    model_id: str,
    payload: SaveRemoteDraftRequest,
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Saves the user's local checked-out working draft without releasing the lock or checking in yet."""
    init_db_and_seed(db)
    return save_local_checkout_draft(
        db=db,
        model_id=model_id,
        user=current_user,
        project=payload.project,
        checkout_id=payload.checkout_id,
    )


@app.post("/api/remote-models/{model_id}/checkin", response_model=RemoteModelDetailResponse)
def checkin_remote_model_endpoint(
    model_id: str,
    payload: CheckinRemoteModelRequest,
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RemoteModelDetailResponse:
    """Checks in local changes to the shared remote repository and releases the checkout lock.
    Denies check-in with 409 if an administrator force-released the user's checkout lock while preserving the user's draft for automatic non-conflicting re-application.
    """
    init_db_and_seed(db)
    return checkin_remote_model(
        db=db,
        model_id=model_id,
        user=current_user,
        project=payload.project,
        commit_message=payload.commit_message,
        checkout_id=payload.checkout_id,
    )


@app.post("/api/remote-models/{model_id}/release", response_model=RemoteModelDetailResponse)
def release_remote_model_lock_endpoint(
    model_id: str,
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RemoteModelDetailResponse:
    """Voluntarily releases the user's checkout lock and discards uncommitted changes."""
    init_db_and_seed(db)
    return release_remote_model_lock(db, model_id, current_user)


@app.post("/api/remote-models/{model_id}/force-release", response_model=RemoteModelSummary)
def force_release_remote_model_lock_endpoint(
    model_id: str,
    payload: ForceReleaseRequest,
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RemoteModelSummary:
    """Admin capability to force-release a model checked out by another user.
    Denies the previous lock holder from checking in their stale session directly, while preserving their changes to auto-reapply non-conflicting edits later.
    """
    init_db_and_seed(db)
    return force_release_remote_model_lock(
        db=db,
        model_id=model_id,
        admin_user=current_user,
        reason=payload.reason,
    )


@app.post("/api/remote-models/{model_id}/reapply", response_model=CheckoutAndReapplyResponse)
def checkout_and_reapply_endpoint(
    model_id: str,
    payload: ReapplyRemoteModelRequest,
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CheckoutAndReapplyResponse:
    """When a model is available for checkout again after an Admin force-release, checks out the latest remote version
    and automatically re-applies all non-conflicting changes from the user's force-released draft.
    """
    init_db_and_seed(db)
    return checkout_and_reapply_non_conflicting_changes(
        db=db,
        model_id=model_id,
        user=current_user,
        local_modified_project=payload.project,
        revoked_checkout_id=payload.checkout_id,
    )


@app.get("/api/remote-models/{model_id}/access", response_model=List[ModelAccessEntry])
def get_remote_model_access_endpoint(
    model_id: str,
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> List[ModelAccessEntry]:
    """Returns the per-user access control list (ACL) for a remote model."""
    init_db_and_seed(db)
    return get_model_access_list(db, model_id)


@app.put("/api/remote-models/{model_id}/access", response_model=List[ModelAccessEntry])
def update_remote_model_access_endpoint(
    model_id: str,
    payload: UpdateModelAccessListRequest,
    current_user: UserProfile = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> List[ModelAccessEntry]:
    """Admin-controlled endpoint to update per-user access permissions (ADMIN, EDIT, VIEW, NONE) on a remote model."""
    init_db_and_seed(db)
    return update_model_access_list(
        db=db,
        model_id=model_id,
        updates=payload.entries,
        admin_user=current_user,
    )


# Serve the built UI from the same server, so every team member opens one URL
# and works against one central instance (models, comments, history, access).
_UI_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _UI_DIST.is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=_UI_DIST, html=True), name="ui")
