import json
import os
from pathlib import Path
import secrets
from typing import Any, Dict
from pydantic import BaseModel


BASE_DIR = Path(__file__).resolve().parent.parent.parent
WORKSPACE_MODEL_DIR = BASE_DIR / "workspace_model"
CANONICAL_MODEL_PATH = WORKSPACE_MODEL_DIR / "canonical_model.json"
EXPORTED_DBT_DIR = WORKSPACE_MODEL_DIR / "exported_dbt"
SQLITE_DB_PATH = BASE_DIR / "backend" / "metaforge_metadata.db"
LOCAL_ENV_PATH = BASE_DIR / ".env"
LOCAL_CONFIG_JSON_PATH = BASE_DIR / "config.local.json"


def _load_dotenv_if_present(env_path: Path) -> None:
    """Load key=value pairs from a local .env file (gitignored) into os.environ if not already set."""
    if not env_path.exists():
        return
    try:
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val
    except Exception:
        pass


def _load_local_json_config(json_path: Path) -> Dict[str, Any]:
    """Load optional overrides from config.local.json (gitignored)."""
    if not json_path.exists():
        return {}
    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


_load_dotenv_if_present(LOCAL_ENV_PATH)
_LOCAL_JSON = _load_local_json_config(LOCAL_CONFIG_JSON_PATH)


def _cfg(env_key: str, json_key: str, default: str = "") -> str:
    val = os.getenv(env_key)
    if val is not None and val != "":
        return val
    jval = _LOCAL_JSON.get(json_key)
    if jval is not None and str(jval) != "":
        return str(jval)
    return default


class Settings(BaseModel):
    app_name: str = "MetaForge Studio"
    version: str = "1.0.0"
    jwt_secret_key: str = _cfg(
        "METAFORGE_JWT_SECRET",
        "jwt_secret_key",
        secrets.token_urlsafe(32),
    )
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = int(_cfg("METAFORGE_JWT_EXPIRE_MINUTES", "jwt_expire_minutes", "1440"))
    database_url: str = _cfg(
        "METAFORGE_DATABASE_URL",
        "database_url",
        f"sqlite:///{SQLITE_DB_PATH}",
    )
    workspace_model_dir: Path = WORKSPACE_MODEL_DIR
    canonical_model_path: Path = CANONICAL_MODEL_PATH
    exported_dbt_dir: Path = EXPORTED_DBT_DIR
    kilo_cli_binary: str = _cfg("KILO_CLI_BINARY", "kilo_cli_binary", "kilo")
    kilo_default_model: str = _cfg("KILO_DEFAULT_MODEL", "kilo_default_model", "anthropic/claude-3-7-sonnet")
    # All API keys default to empty string ("") and are never hardcoded in source code.
    # Users can either save their personal API key via the UI (stored per-user in their local DB)
    # or set GEMINI_API_KEY / LLM_API_KEY in their gitignored .env or config.local.json.
    llm_api_key: str = _cfg("LLM_API_KEY", "llm_api_key", "")
    llm_base_url: str = _cfg("LLM_BASE_URL", "llm_base_url", "https://api.openai.com/v1")
    llm_model: str = _cfg("LLM_MODEL", "llm_model", "gpt-4o")
    gemini_api_key: str = _cfg("GEMINI_API_KEY", "gemini_api_key", "")
    gemini_model: str = _cfg("GEMINI_MODEL", "gemini_model", "gemini-2.5-flash")
    devin_api_key: str = _cfg("DEVIN_API_KEY", "devin_api_key", "")


settings = Settings()
