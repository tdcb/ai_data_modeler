import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent.parent
BACKEND_DIR = ROOT_DIR / "backend"

for p in (str(ROOT_DIR), str(BACKEND_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

import json  # noqa: E402

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def isolated_ai_settings(tmp_path, monkeypatch):
    """Each test gets its own AI settings file (metadata-only mode on by default)."""
    path = tmp_path / "ai_settings.json"
    monkeypatch.setenv("METAFORGE_AI_SETTINGS", str(path))
    return path


@pytest.fixture
def profiling_allowed(isolated_ai_settings):
    """Opt out of metadata-only mode for tests that exercise live row profiling."""
    isolated_ai_settings.write_text(json.dumps({"privacy": {"metadata_only": False}}))
