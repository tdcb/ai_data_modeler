"""LLM providers. Every provider exposes complete(prompt, system) -> str.

CLI providers (Kiro CLI, Gemini CLI, Devin CLI) run headless subprocesses so the user's existing CLI login is
reused (no API key). `builtin` is the offline, deterministic engine used when no LLM is configured.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from ..config import settings as app_settings

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
        "label": "Devin CLI (local)",
        "kind": "cli",
        "fields": ["command", "model", "timeout"],
        "defaults": {"command": "devin --respect-workspace-trust=false -p", "model": "", "timeout": 900},
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


_DEVIN_AUTH_OK: set = set()


class DevinCliProvider(Provider):
    """Local Devin CLI in single-turn print mode with --prompt-file; reuses the CLI login on this machine."""

    def _complete(self, prompt, system, images):
        cmd = str(self.config.get("command") or PROVIDERS["devin"]["defaults"]["command"]).split()
        exe = shutil.which(cmd[0])
        if not exe:
            raise LLMError(f"Devin CLI '{cmd[0]}' not found on PATH (install: https://cli.devin.ai)")
        if exe not in _DEVIN_AUTH_OK:
            st = subprocess.run(
                [exe, "auth", "status"],
                capture_output=True,
                text=True,
                timeout=30,
                stdin=subprocess.DEVNULL,
                encoding="utf-8",
                errors="replace",
            )
            if st.returncode != 0 or "not logged in" in (st.stdout + st.stderr).lower():
                raise LLMError("Devin CLI is not logged in on the machine running the backend. Run `devin auth login`.")
            _DEVIN_AUTH_OK.add(exe)
        if self.config.get("model"):
            cmd += ["--model", str(self.config["model"])]
        full = _with_images(CLI_TEXT_ONLY + (f"{system}\n\n" if system else "") + prompt, images, False)
        with tempfile.TemporaryDirectory(prefix="aidm_devin_") as d:
            pf = Path(d) / "prompt.md"
            pf.write_text(full, encoding="utf-8")
            return _run(cmd + ["--prompt-file", str(pf)], "", int(self.config.get("timeout", 900)), cwd=d)


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
        key = (self.api_key or os.getenv("LLM_API_KEY", "") or app_settings.llm_api_key).strip()
        if not key:
            raise LLMError("LLM_API_KEY is not set for the OpenAI-compatible provider.")
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
    "devin": DevinCliProvider,
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
        "devin": bool(shutil.which("devin")),
        "gemini_api": bool(os.getenv("GEMINI_API_KEY") or app_settings.gemini_api_key),
        "openai": bool(os.getenv("LLM_API_KEY") or app_settings.llm_api_key),
    }
