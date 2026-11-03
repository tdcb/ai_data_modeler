"""Server-side AI provider + privacy settings (workspace_model/ai_settings.json, gitignored)."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict

from ..config import settings

DEFAULT_SETTINGS: Dict[str, Any] = {
    "active_provider": "builtin",
    "providers": {},
    "privacy": {
        # Only structural metadata ever leaves the app (names, types, keys, constraints, indexes, views,
        # descriptions). Row values, samples, min/max and row counts are never read or sent.
        "metadata_only": True,
        "audit_ai_calls": True,
    },
}


def settings_path() -> Path:
    return Path(os.getenv("METAFORGE_AI_SETTINGS", str(settings.workspace_model_dir / "ai_settings.json")))


def load_ai_settings() -> Dict[str, Any]:
    data = json.loads(json.dumps(DEFAULT_SETTINGS))
    p = settings_path()
    if p.exists():
        try:
            stored = json.loads(p.read_text(encoding="utf-8"))
            data["active_provider"] = stored.get("active_provider", data["active_provider"])
            data["providers"].update(stored.get("providers") or {})
            data["privacy"].update(stored.get("privacy") or {})
        except Exception:
            pass
    return data


def save_ai_settings(data: Dict[str, Any]) -> Dict[str, Any]:
    cur = load_ai_settings()
    if "active_provider" in data and data["active_provider"]:
        cur["active_provider"] = data["active_provider"]
    for name, cfg in (data.get("providers") or {}).items():
        cur["providers"][name] = {k: v for k, v in (cfg or {}).items() if k != "api_key"}
    cur["privacy"].update(data.get("privacy") or {})
    p = settings_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cur, indent=2), encoding="utf-8")
    return cur


def metadata_only() -> bool:
    return bool(load_ai_settings()["privacy"].get("metadata_only", True))
