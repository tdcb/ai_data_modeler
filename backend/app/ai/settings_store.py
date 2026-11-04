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


def secrets_path() -> Path:
    return settings_path().with_name("ai_secrets.json")


def load_secrets() -> Dict[str, Dict[str, str]]:
    p = secrets_path()
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8")) or {}
        except Exception:
            return {}
    return {}


def get_secret(provider: str, name: str = "api_key") -> str:
    return str((load_secrets().get(provider) or {}).get(name) or "").strip()


def _write_secrets(data: Dict[str, Dict[str, str]]) -> None:
    p = secrets_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.chmod(p, 0o600)


def mask(value: str) -> str:
    return f"…{value[-4:]}" if len(value) > 8 else "••••"


SECRET_KEYS = ("api_key",)


def save_ai_settings(data: Dict[str, Any]) -> Dict[str, Any]:
    cur = load_ai_settings()
    if "active_provider" in data and data["active_provider"]:
        cur["active_provider"] = data["active_provider"]
    secrets = load_secrets()
    secrets_changed = False
    for name, cfg in (data.get("providers") or {}).items():
        cfg = dict(cfg or {})
        for k in SECRET_KEYS:
            val = cfg.pop(k, None)
            if cfg.pop(f"clear_{k}", False):
                secrets.get(name, {}).pop(k, None)
                secrets_changed = True
            elif isinstance(val, str) and val.strip():
                secrets.setdefault(name, {})[k] = val.strip()
                secrets_changed = True
        cur["providers"][name] = {**cur["providers"].get(name, {}), **cfg}
    if secrets_changed:
        _write_secrets({k: v for k, v in secrets.items() if v})
    cur["privacy"].update(data.get("privacy") or {})
    p = settings_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cur, indent=2), encoding="utf-8")
    return cur


def metadata_only() -> bool:
    return bool(load_ai_settings()["privacy"].get("metadata_only", True))
