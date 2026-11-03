"""Project context library: notes, transcripts, briefs, DDL and diagrams the AI uses as background."""

from __future__ import annotations

import io
import json
import re
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..config import settings

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
TEXT_EXT = {
    ".txt",
    ".md",
    ".markdown",
    ".sql",
    ".ddl",
    ".dbml",
    ".mmd",
    ".mermaid",
    ".json",
    ".yml",
    ".yaml",
    ".csv",
    ".vtt",
    ".srt",
    ".puml",
    ".html",
    ".htm",
    "",
}


def library_dir() -> Path:
    d = settings.workspace_model_dir / "context_library"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _index_path() -> Path:
    return library_dir() / "index.json"


def _load_index() -> List[Dict[str, Any]]:
    p = _index_path()
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_index(items: List[Dict[str, Any]]) -> None:
    _index_path().write_text(json.dumps(items, indent=2), encoding="utf-8")


def _clean_transcript(text: str) -> str:
    lines = []
    for ln in text.splitlines():
        s = ln.strip()
        if not s or s == "WEBVTT" or s.isdigit() or "-->" in s:
            continue
        lines.append(s)
    return "\n".join(lines)


def extract_text(filename: str, data: bytes) -> str:
    ext = Path(filename).suffix.lower()
    if ext == ".docx":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            xml = z.read("word/document.xml").decode("utf-8", "replace")
        xml = re.sub(r"</w:p>", "\n", xml)
        return re.sub(r"<[^>]+>", "", xml).strip()
    if ext == ".pdf":
        try:
            from pypdf import PdfReader  # optional dependency
        except Exception as exc:
            raise ValueError("PDF support needs `pip install pypdf`; or paste the text instead.") from exc
        reader = PdfReader(io.BytesIO(data))
        return "\n".join((pg.extract_text() or "") for pg in reader.pages)
    if ext == ".csv":
        # Metadata only: keep the header row, never the data rows.
        first = data.decode("utf-8", "replace").splitlines()[:1]
        return "CSV columns: " + (first[0] if first else "")
    text = data.decode("utf-8", "replace")
    if ext in (".vtt", ".srt"):
        return _clean_transcript(text)
    if ext in (".html", ".htm"):
        return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text))
    return text


def _kind(filename: str, text: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext in IMAGE_EXT:
        return "diagram_image"
    if ext in (".vtt", ".srt") or re.search(r"^\s*\[?\d{1,2}:\d{2}", text, re.M):
        return "transcript"
    if ext in (".sql", ".ddl") or re.search(r"\bcreate\s+table\b", text, re.I):
        return "ddl"
    if ext in (".dbml", ".mmd", ".mermaid", ".puml") or re.search(r"^\s*(erDiagram|Table\s+\w)", text, re.M):
        return "diagram_text"
    return "notes"


def add_document(
    filename: str, data: Optional[bytes] = None, text: Optional[str] = None, title: Optional[str] = None
) -> Dict[str, Any]:
    doc_id = uuid.uuid4().hex[:12]
    ext = Path(filename).suffix.lower()
    item: Dict[str, Any] = {
        "id": doc_id,
        "title": title or filename,
        "filename": filename,
        "added_at": time.strftime("%Y-%m-%d %H:%M"),
        "include": True,
    }
    if ext in IMAGE_EXT and data is not None:
        path = library_dir() / f"{doc_id}{ext}"
        path.write_bytes(data)
        item.update({"kind": "diagram_image", "image_path": path.name, "chars": 0})
    else:
        body = text if text is not None else extract_text(filename, data or b"")
        (library_dir() / f"{doc_id}.txt").write_text(body, encoding="utf-8")
        item.update({"kind": _kind(filename, body), "chars": len(body), "preview": body[:240]})
    items = _load_index()
    items.append(item)
    _save_index(items)
    return item


def list_documents() -> List[Dict[str, Any]]:
    return _load_index()


def update_document(doc_id: str, patch: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    items = _load_index()
    for it in items:
        if it["id"] == doc_id:
            for k in ("title", "include"):
                if k in patch:
                    it[k] = patch[k]
            _save_index(items)
            return it
    return None


def delete_document(doc_id: str) -> bool:
    items = _load_index()
    keep = [i for i in items if i["id"] != doc_id]
    for it in items:
        if it["id"] == doc_id:
            for name in (f"{doc_id}.txt", it.get("image_path") or ""):
                if name:
                    (library_dir() / name).unlink(missing_ok=True)
    _save_index(keep)
    return len(keep) != len(items)


def document_text(doc_id: str) -> str:
    p = library_dir() / f"{doc_id}.txt"
    return p.read_text(encoding="utf-8") if p.exists() else ""


def gather(doc_ids: Optional[List[str]] = None, max_chars: int = 40000) -> Dict[str, Any]:
    """Text + image paths for the chosen documents (default: every document flagged `include`)."""
    texts: List[str] = []
    images: List[Path] = []
    for it in _load_index():
        if doc_ids is not None and it["id"] not in doc_ids:
            continue
        if doc_ids is None and not it.get("include", True):
            continue
        if it.get("image_path"):
            images.append(library_dir() / it["image_path"])
        else:
            texts.append(f"--- {it['title']} ({it['kind']}) ---\n{document_text(it['id'])}")
    joined = "\n\n".join(texts)
    return {"text": joined[:max_chars], "images": images}
