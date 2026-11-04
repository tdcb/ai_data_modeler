"""/api/ai/* endpoints: providers, privacy, context library, generate, search, document, explain, chat, editor."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth.dependencies import get_current_user
from ..auth.models import UserProfile, UserRecord, UserRole, get_db
from ..config import settings
from ..metamodel.schema import ProjectMetamodel
from ..metamodel.seed import ensure_seed_workspace
from . import context_library as lib
from . import documenter, editor_dsl, generator
from . import search as search_mod
from .companion import chat as companion_chat
from .privacy import NEVER_SENT, ai_catalog, read_audit, record_ai_call, scrub_row_data
from .providers import (
    PROVIDERS,
    LLMError,
    Provider,
    detect_available,
    get_provider,
    secret_source,
)
from .settings_store import get_secret, load_ai_settings, mask, save_ai_settings

router = APIRouter(prefix="/api/ai", tags=["ai"])
EDITORS = (UserRole.ADMIN, UserRole.ARCHITECT, UserRole.STEWARD)


class AIRequest(BaseModel):
    project: Optional[ProjectMetamodel] = None
    provider: Optional[str] = None
    provider_config: Optional[Dict[str, Any]] = None


class GenerateRequest(AIRequest):
    text: str = ""
    doc_ids: Optional[List[str]] = None
    use_library: bool = True
    subject_area: str = "Core"
    instructions: str = ""


class ApplySpecRequest(AIRequest):
    spec: Dict[str, Any]


class SearchRequest(AIRequest):
    query: str
    use_ai: bool = False


class DocumentRequest(AIRequest):
    entity_ids: Optional[List[str]] = None
    only_missing: bool = True


class ApplyDocsRequest(AIRequest):
    proposals: List[Dict[str, Any]]


class ExplainRequest(AIRequest):
    entity_id: Optional[str] = None
    column_id: Optional[str] = None
    relationship_id: Optional[str] = None


class ChatRequest(AIRequest):
    prompt: str
    history: List[Dict[str, str]] = []
    use_context: bool = True


class EditorRequest(AIRequest):
    text: str = ""
    dialect: str = "snowflake"


class ContextText(BaseModel):
    title: str = "Pasted notes"
    text: str


def _model(req: AIRequest) -> ProjectMetamodel:
    return req.project or ensure_seed_workspace(settings.canonical_model_path)


def _provider(req: AIRequest, user: UserProfile, db: Session) -> Provider:
    cfg = load_ai_settings()
    name = req.provider or cfg["active_provider"]
    conf = dict(cfg["providers"].get(name) or {})
    conf.update(req.provider_config or {})
    key = str((req.provider_config or {}).get("api_key") or "").strip()
    if not key and name == "gemini_api":
        rec = db.query(UserRecord).filter(UserRecord.id == user.id).first()
        key = (rec.gemini_api_key if rec else "") or ""
    try:
        return get_provider(name, conf, key)
    except LLMError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


def _audit(feature: str, p: Provider) -> None:
    if not p.is_offline and load_ai_settings()["privacy"].get("audit_ai_calls", True):
        for c in p.calls:
            record_ai_call(feature, p.label, c["prompt_chars"], c["ok"])


def _require_editor(user: UserProfile) -> None:
    if user.role not in EDITORS:
        raise HTTPException(status_code=403, detail="Your role is read-only; model changes are not allowed.")


@router.get("/providers")
def providers(user: UserProfile = Depends(get_current_user)) -> Dict[str, Any]:
    cfg = load_ai_settings()
    avail = detect_available()
    return {
        "active_provider": cfg["active_provider"],
        "privacy": cfg["privacy"],
        "providers": [
            {
                "name": n,
                "label": p["label"],
                "kind": p["kind"],
                "fields": p["fields"],
                "defaults": p["defaults"],
                "config": cfg["providers"].get(n, {}),
                "available": avail.get(n, False),
                "secret_fields": p.get("secret_fields", []),
                "secrets": {f: _secret_info(n, f) for f in p.get("secret_fields", [])},
            }
            for n, p in PROVIDERS.items()
        ],
    }


def _secret_info(provider: str, field_name: str) -> Dict[str, Any]:
    stored = get_secret(provider, field_name)
    source = secret_source(provider)
    return {"set": bool(source), "source": source, "hint": mask(stored) if stored else ""}


@router.put("/settings")
def put_settings(payload: Dict[str, Any], user: UserProfile = Depends(get_current_user)) -> Dict[str, Any]:
    if payload.get("active_provider") and payload["active_provider"] not in PROVIDERS:
        raise HTTPException(status_code=400, detail="Unknown provider")
    touches_secret = any(
        isinstance(c, dict) and (str(c.get("api_key") or "").strip() or c.get("clear_api_key"))
        for c in (payload.get("providers") or {}).values()
    )
    if touches_secret and user.role not in (UserRole.ADMIN, UserRole.ARCHITECT):
        raise HTTPException(status_code=403, detail="Only admins and data architects can change AI API keys.")
    if "privacy" in payload and user.role != UserRole.ADMIN and payload["privacy"].get("metadata_only") is False:
        raise HTTPException(status_code=403, detail="Only admins can disable metadata-only mode.")
    return save_ai_settings(payload)


@router.post("/providers/{name}/test")
def test_provider(
    name: str, req: AIRequest, user: UserProfile = Depends(get_current_user), db: Session = Depends(get_db)
) -> Dict[str, Any]:
    req.provider = name
    p = _provider(req, user, db)
    return p.test()


@router.get("/privacy")
def privacy(user: UserProfile = Depends(get_current_user)) -> Dict[str, Any]:
    return {
        "settings": load_ai_settings()["privacy"],
        "never_sent": NEVER_SENT,
        "sent": [
            "database, schema, table and view names",
            "column names, data types, keys and constraints",
            "indexes/clustering and view SQL",
            "descriptions, logical names, tags, PII labels",
            "context documents you add to the library",
        ],
        "audit": read_audit(50),
    }


@router.post("/privacy/preview")
def privacy_preview(req: AIRequest, user: UserProfile = Depends(get_current_user)) -> Dict[str, Any]:
    cat = ai_catalog(_model(req))
    import json

    return {"catalog": cat, "chars": len(json.dumps(cat, separators=(",", ":")))}


@router.post("/privacy/scrub")
def privacy_scrub(req: AIRequest, user: UserProfile = Depends(get_current_user)) -> Dict[str, Any]:
    m = _model(req).model_copy(deep=True)
    n = scrub_row_data(m)
    return {"project": m, "cleared": n}


@router.get("/context")
def context_list(user: UserProfile = Depends(get_current_user)) -> List[Dict[str, Any]]:
    return lib.list_documents()


@router.post("/context/upload")
async def context_upload(
    file: UploadFile = File(...), title: str = Form(""), user: UserProfile = Depends(get_current_user)
) -> Dict[str, Any]:
    data = await file.read()
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (20 MB max)")
    try:
        return lib.add_document(file.filename or "upload.txt", data=data, title=title or None)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/context/text")
def context_text(payload: ContextText, user: UserProfile = Depends(get_current_user)) -> Dict[str, Any]:
    return lib.add_document(payload.title + ".md", text=payload.text, title=payload.title)


@router.get("/context/{doc_id}")
def context_get(doc_id: str, user: UserProfile = Depends(get_current_user)) -> Dict[str, Any]:
    return {"id": doc_id, "text": lib.document_text(doc_id)}


@router.patch("/context/{doc_id}")
def context_patch(doc_id: str, patch: Dict[str, Any], user: UserProfile = Depends(get_current_user)):
    it = lib.update_document(doc_id, patch)
    if not it:
        raise HTTPException(status_code=404, detail="Document not found")
    return it


@router.delete("/context/{doc_id}")
def context_delete(doc_id: str, user: UserProfile = Depends(get_current_user)) -> Dict[str, Any]:
    return {"deleted": lib.delete_document(doc_id)}


@router.post("/generate")
def generate(
    req: GenerateRequest, user: UserProfile = Depends(get_current_user), db: Session = Depends(get_db)
) -> Dict[str, Any]:
    model = _model(req)
    docs = lib.gather(req.doc_ids) if (req.use_library or req.doc_ids) else {"text": "", "images": []}
    text = "\n\n".join(t for t in (req.text, docs["text"]) if t.strip())
    if not text.strip() and not docs["images"]:
        raise HTTPException(status_code=400, detail="Provide notes/transcript text or add documents to the library.")
    p = _provider(req, user, db)
    spec = generator.generate_spec(p, text, model, req.subject_area, docs["images"], req.instructions)
    _audit("generate", p)
    return {"spec": spec, "diff": generator.diff_spec(model, spec)}


@router.post("/generate/apply")
def generate_apply(req: ApplySpecRequest, user: UserProfile = Depends(get_current_user)) -> Dict[str, Any]:
    _require_editor(user)
    m = _model(req).model_copy(deep=True)
    actions = generator.apply_spec(m, req.spec)
    return {"project": m, "actions": actions}


@router.post("/search")
def search(
    req: SearchRequest, user: UserProfile = Depends(get_current_user), db: Session = Depends(get_db)
) -> Dict[str, Any]:
    p = _provider(req, user, db) if req.use_ai else None
    out = search_mod.search(_model(req), req.query, p)
    if p:
        _audit("search", p)
    return out


@router.post("/document")
def document(
    req: DocumentRequest, user: UserProfile = Depends(get_current_user), db: Session = Depends(get_db)
) -> Dict[str, Any]:
    p = _provider(req, user, db)
    out = documenter.propose_documentation(_model(req), p, req.entity_ids, req.only_missing)
    _audit("document", p)
    return out


@router.post("/document/apply")
def document_apply(req: ApplyDocsRequest, user: UserProfile = Depends(get_current_user)) -> Dict[str, Any]:
    _require_editor(user)
    m = _model(req).model_copy(deep=True)
    n = documenter.apply_documentation(m, req.proposals)
    return {"project": m, "applied": n}


@router.post("/explain")
def explain(
    req: ExplainRequest, user: UserProfile = Depends(get_current_user), db: Session = Depends(get_db)
) -> Dict[str, Any]:
    p = _provider(req, user, db)
    out = documenter.explain(_model(req), req.entity_id, req.column_id, req.relationship_id, p)
    _audit("explain", p)
    return out


@router.post("/chat")
def chat(
    req: ChatRequest, user: UserProfile = Depends(get_current_user), db: Session = Depends(get_db)
) -> Dict[str, Any]:
    p = _provider(req, user, db)
    ctx = lib.gather()["text"] if req.use_context else ""
    out = companion_chat(_model(req), req.prompt, p, req.history, ctx, allow_mutations=user.role in EDITORS)
    _audit("chat", p)
    return out


@router.post("/editor/render")
def editor_render(req: EditorRequest, user: UserProfile = Depends(get_current_user)) -> Dict[str, Any]:
    return {"text": editor_dsl.render(_model(req), req.dialect)}


@router.post("/editor/apply")
def editor_apply(req: EditorRequest, user: UserProfile = Depends(get_current_user)) -> Dict[str, Any]:
    out = editor_dsl.apply(_model(req), req.text, req.dialect)
    if out["ok"] and out["changes"]:
        _require_editor(user)
    return out
