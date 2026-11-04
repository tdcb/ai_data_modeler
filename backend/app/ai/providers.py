"""LLM providers. Every provider exposes complete(prompt, system) -> str.

CLI providers (Kiro CLI, Gemini CLI) run headless subprocesses so the user's existing CLI login is
reused (no API key). `devin` runs the request as a Devin cloud session via the Devin API.
`builtin` is the offline, deterministic engine used when no LLM is configured.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from ..config import settings as app_settings
from .settings_store import get_secret

PROVIDERS: Dict[str, Dict[str, Any]] = {
    "builtin": {"label": "Built-in (offline, no LLM)", "kind": "offline", "fields": [], "defaults": {}},
    "kiro": {
        "label": "Kiro CLI",
        "kind": "cli",
        "fields": ["command", "model", "timeout"],
        "defaults": {"command": "kiro-cli chat --no-interactive", "model": "", "timeout": 600},
    },
    "gemini_cli": {
        "label": "Gemini CLI",
        "kind": "cli",
        "fields": ["command", "model", "timeout"],
        "defaults": {"command": "gemini", "model": "", "timeout": 600},
    },
    "devin": {
        "label": "Devin",
        "kind": "api",
        "fields": ["api_base", "max_acu_limit", "timeout"],
        "secret_fields": ["api_key"],
        "defaults": {"api_base": "https://api.devin.ai/v1", "max_acu_limit": "", "timeout": 1800},
    },
    "gemini_api": {
        "label": "Google Gemini API",
        "kind": "api",
        "fields": ["model", "timeout"],
        "defaults": {"model": app_settings.gemini_model or "gemini-2.5-flash", "timeout": 120},
    },
    "openai": {
        "label": "OpenAI-compatible API",
        "kind": "api",
        "fields": ["base_url", "model", "timeout"],
        "secret_fields": ["api_key"],
        "defaults": {"base_url": app_settings.llm_base_url, "model": app_settings.llm_model, "timeout": 120},
    },
}

CLI_TEXT_ONLY = (
    "You are being called as a text-generation step inside a data modeling application. Do NOT use tools: do not "
    "read, create or edit files and do not run commands. Everything you need is in this prompt. Reply only with "
    "the requested output, in the requested format.\n\n"
)


class LLMError(RuntimeError):
    pass


@dataclass
class Provider:
    name: str
    config: Dict[str, Any] = field(default_factory=dict)
    api_key: str = ""
    calls: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def is_offline(self) -> bool:
        return self.name == "builtin"

    @property
    def label(self) -> str:
        return PROVIDERS[self.name]["label"] + (f" ({self.config['model']})" if self.config.get("model") else "")

    def complete(self, prompt: str, system: str = "", images: Optional[List[Path]] = None) -> str:
        t0 = time.time()
        try:
            out = self._complete(prompt, system, images or [])
            self.calls.append({"ok": True, "prompt_chars": len(prompt) + len(system), "seconds": time.time() - t0})
            return out
        except subprocess.TimeoutExpired as e:
            raise LLMError(f"{self.label} timed out after {e.timeout}s") from e

    def complete_json(self, prompt: str, system: str = "", images: Optional[List[Path]] = None) -> Any:
        sys2 = (system + "\n\nRespond with a single valid JSON value only. No prose, no markdown fences.").strip()
        out = self.complete(prompt, sys2, images)
        val = extract_json(out)
        if val is None:
            out = self.complete(prompt + "\n\nYour previous answer was not valid JSON. Return only JSON.", sys2, images)
            val = extract_json(out)
        if val is None:
            raise LLMError(f"{self.label} did not return JSON: {out[:300]}")
        return val

    def _complete(self, prompt: str, system: str, images: List[Path]) -> str:  # pragma: no cover
        raise NotImplementedError

    def test(self) -> Dict[str, Any]:
        try:
            out = self.complete("Reply with the single word OK.")
            return {"ok": "ok" in out.lower(), "output": out[:200]}
        except Exception as e:
            return {"ok": False, "output": str(e)[:500]}


def extract_json(text: str) -> Any:
    text = strip_ansi(text or "").strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if m:
        text = m.group(1).strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    for open_c, close_c in (("{", "}"), ("[", "]")):
        s, e = text.find(open_c), text.rfind(close_c)
        if s != -1 and e > s:
            try:
                return json.loads(text[s : e + 1])
            except Exception:
                continue
    return None


def strip_ansi(s: str) -> str:
    return re.sub(
        r"\x1b\[[0-9;?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]", "", s or ""
    )


def _run(cmd: List[str], stdin: str, timeout: int, cwd: Optional[str] = None) -> str:
    exe = shutil.which(cmd[0])
    if not exe:
        raise LLMError(f"'{cmd[0]}' was not found on the PATH of the machine running the backend")
    io: Dict[str, Any] = {"input": stdin} if stdin else {"stdin": subprocess.DEVNULL}
    p = subprocess.run(
        [exe] + cmd[1:],
        **io,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=cwd,
        encoding="utf-8",
        errors="replace",
    )
    if p.returncode != 0 and not p.stdout.strip():
        raise LLMError(f"{cmd[0]} exited {p.returncode}: {p.stderr.strip()[:500]}")
    return strip_ansi(p.stdout).strip()


def _with_images(full: str, images: List[Path], at_syntax: bool) -> str:
    if not images:
        return full
    if at_syntax:
        return full + "\n\nAttached diagrams/images: " + " ".join(f"@{p}" for p in images)
    return full + "\n\n(Image attachments were omitted: this provider only accepts text.)"


class BuiltinProvider(Provider):
    def _complete(self, prompt, system, images):
        return "OK" if "single word OK" in prompt else "{}"


class KiroProvider(Provider):
    def _complete(self, prompt, system, images):
        cmd = str(self.config.get("command") or PROVIDERS["kiro"]["defaults"]["command"]).split()
        if self.config.get("model"):
            cmd += ["--model", str(self.config["model"])]
        full = _with_images(CLI_TEXT_ONLY + (f"{system}\n\n" if system else "") + prompt, images, False)
        if len(full) < 30000:
            return _run(cmd + [full], "", int(self.config.get("timeout", 600)))
        return _run(cmd, full, int(self.config.get("timeout", 600)))


class GeminiCliProvider(Provider):
    def _complete(self, prompt, system, images):
        cmd = str(self.config.get("command") or "gemini").split()
        if self.config.get("model"):
            cmd += ["-m", str(self.config["model"])]
        full = _with_images(CLI_TEXT_ONLY + (f"{system}\n\n" if system else "") + prompt, images, True)
        # `gemini -p` takes the flag prompt and appends stdin, so long prompts never hit argv limits.
        return _run(
            cmd + ["-p", "Follow the instructions provided on stdin."], full, int(self.config.get("timeout", 600))
        )


DEVIN_ANALYST = (
    "You are acting as the analysis engine of a data modeling application. Analyse the user's request against the "
    "model metadata below and reply in this session's chat. Do not create pull requests, clone repositories, edit "
    "files or run commands: everything you need is in this message. Send exactly one final message containing only "
    "the requested output.\n\n"
)


class DevinApiProvider(Provider):
    """Devin cloud API: each request runs as a Devin session that analyses it and replies with the result."""

    poll_seconds = 10.0

    def _key(self) -> str:
        key = (self.api_key or get_secret("devin") or os.getenv("DEVIN_API_KEY", "") or app_settings.devin_api_key).strip()
        if not key:
            raise LLMError("Devin API key missing: add it in AI → provider settings (gear icon).")
        return key

    def _complete(self, prompt, system, images):
        base = str(self.config.get("api_base") or PROVIDERS["devin"]["defaults"]["api_base"]).rstrip("/")
        hdr = {"Authorization": f"Bearer {self._key()}", "Content-Type": "application/json"}
        body: Dict[str, Any] = {"prompt": DEVIN_ANALYST + (f"{system}\n\n" if system else "") + prompt,
                                "idempotent": False, "title": "AI Data Modeler request"}
        if str(self.config.get("max_acu_limit") or "").strip():
            body["max_acu_limit"] = int(self.config["max_acu_limit"])
        r = httpx.post(f"{base}/sessions", headers=hdr, json=body, timeout=60)
        if r.status_code >= 300:
            raise LLMError(f"Devin API error {r.status_code}: {r.text[:300]}")
        created = r.json()
        sid = created.get("session_id")
        self.last_session_url = created.get("url", "")
        deadline = time.time() + int(self.config.get("timeout") or 1800)
        while time.time() < deadline:
            time.sleep(self.poll_seconds)
            g = httpx.get(f"{base}/session/{sid}", headers=hdr, timeout=60)
            if g.status_code >= 300:
                continue
            d = g.json()
            status = str(d.get("status_enum") or d.get("status") or "").lower()
            msgs = [m for m in (d.get("messages") or []) if m.get("type") == "devin_message" and m.get("message")]
            if d.get("structured_output"):
                return json.dumps(d["structured_output"])
            if status in ("blocked", "finished", "stopped", "expired", "suspend_requested") and msgs:
                return str(msgs[-1]["message"])
            if status in ("stopped", "expired", "finished") and not msgs:
                raise LLMError(f"Devin session {sid} ended ({status}) without a reply")
        raise LLMError(f"Devin session {sid} did not reply within {self.config.get('timeout')}s")

    def test(self) -> Dict[str, Any]:
        try:
            base = str(self.config.get("api_base") or PROVIDERS["devin"]["defaults"]["api_base"]).rstrip("/")
            r = httpx.get(f"{base}/sessions", params={"limit": 1},
                          headers={"Authorization": f"Bearer {self._key()}"}, timeout=30)
            return {"ok": r.status_code == 200, "output": "API key accepted" if r.status_code == 200
                    else f"HTTP {r.status_code}: {r.text[:200]}"}
        except Exception as e:
            return {"ok": False, "output": str(e)[:500]}


class GeminiApiProvider(Provider):
    def _complete(self, prompt, system, images):
        key = (self.api_key or os.getenv("GEMINI_API_KEY", "") or app_settings.gemini_api_key).strip()
        if not key:
            raise LLMError("Gemini API key missing: save it under Profile -> AI API Keys or set GEMINI_API_KEY.")
        import base64
        import mimetypes

        parts: List[Dict[str, Any]] = [{"text": prompt}]
        for img in images:
            mime = mimetypes.guess_type(str(img))[0] or "image/png"
            parts.append({"inline_data": {"mime_type": mime, "data": base64.b64encode(img.read_bytes()).decode()}})
        body: Dict[str, Any] = {
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"temperature": 0.2},
        }
        if system:
            body["system_instruction"] = {"parts": [{"text": system}]}
        model = self.config.get("model") or "gemini-2.5-flash"
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        r = httpx.post(url, params={"key": key}, json=body, timeout=float(self.config.get("timeout", 120)))
        if r.status_code != 200:
            raise LLMError(f"Gemini API error {r.status_code}: {r.text[:300]}")
        cands = r.json().get("candidates") or []
        if not cands:
            raise LLMError("Gemini API returned no candidates")
        return "".join(p.get("text", "") for p in cands[0].get("content", {}).get("parts", []))


class OpenAIProvider(Provider):
    def _complete(self, prompt, system, images):
        key = (self.api_key or get_secret("openai") or os.getenv("LLM_API_KEY", "") or app_settings.llm_api_key).strip()
        if not key:
            raise LLMError("API key missing for the OpenAI-compatible provider: add it in AI → provider settings (gear icon).")
        msgs = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
        base = str(self.config.get("base_url") or "https://api.openai.com/v1").rstrip("/")
        r = httpx.post(
            f"{base}/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={"model": self.config.get("model") or "gpt-4o", "messages": msgs, "temperature": 0.2},
            timeout=float(self.config.get("timeout", 120)),
        )
        if r.status_code != 200:
            raise LLMError(f"LLM API error {r.status_code}: {r.text[:300]}")
        return r.json()["choices"][0]["message"]["content"]


_CLASSES = {
    "builtin": BuiltinProvider,
    "kiro": KiroProvider,
    "gemini_cli": GeminiCliProvider,
    "devin": DevinApiProvider,
    "gemini_api": GeminiApiProvider,
    "openai": OpenAIProvider,
}


def get_provider(name: str, config: Optional[Dict[str, Any]] = None, api_key: str = "") -> Provider:
    if name not in _CLASSES:
        raise LLMError(f"Unknown AI provider '{name}'. Choose one of: {', '.join(_CLASSES)}")
    cfg = dict(PROVIDERS[name]["defaults"])
    cfg.update({k: v for k, v in (config or {}).items() if v not in (None, "") and k in PROVIDERS[name]["fields"]})
    return _CLASSES[name](name=name, config=cfg, api_key=api_key or "")


def detect_available() -> Dict[str, bool]:
    return {
        "builtin": True,
        "kiro": bool(shutil.which("kiro-cli")),
        "gemini_cli": bool(shutil.which("gemini")),
        "devin": bool(secret_source("devin")),
        "gemini_api": bool(os.getenv("GEMINI_API_KEY") or app_settings.gemini_api_key),
        "openai": bool(secret_source("openai")),
    }


_SECRET_ENV = {"devin": ("DEVIN_API_KEY", "devin_api_key"), "openai": ("LLM_API_KEY", "llm_api_key")}


def secret_source(provider: str) -> str:
    """Where the provider's API key comes from: 'ui' (saved in settings), 'env' (backend env/config) or ''."""
    if get_secret(provider):
        return "ui"
    env, attr = _SECRET_ENV.get(provider, ("", ""))
    if env and (os.getenv(env) or getattr(app_settings, attr, "")):
        return "env"
    return ""
