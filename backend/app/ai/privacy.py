"""Privacy-first metadata boundary.

Everything the AI features see is produced by `ai_catalog()`: database/schema/table/column names, data types,
keys, constraints, indexes, views and descriptions. Row values (profile samples, min/max, enum values), row
counts and imported sample rows are never included, and `scrub_row_data()` strips them from a model when the
workspace runs in metadata-only mode.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..config import settings
from ..metamodel.schema import ProjectMetamodel

NEVER_SENT = [
    "table rows / transactional records",
    "column sample values, min/max values and enum values from profiling",
    "row counts and volumetrics",
    "credentials, connection strings and API keys",
]


def _col_type(col: Any, dialect: str) -> str:
    return {
        "sql_server": col.data_type_sql_server,
        "oracle": col.data_type_oracle,
    }.get(dialect, col.data_type_snowflake)


def ai_catalog(
    model: ProjectMetamodel, dialect: str = "snowflake", entity_ids: Optional[List[str]] = None
) -> Dict[str, Any]:
    """Compact metadata-only catalogue of the model, safe to send to an LLM."""
    ents = [e for e in model.entities.values() if not entity_ids or e.id in entity_ids]
    by_id = {e.id: e for e in model.entities.values()}
    tables = []
    for e in ents:
        cols = []
        for c in e.columns:
            flags = [
                f
                for f, on in (
                    ("pk", c.is_pk),
                    ("fk", c.is_fk),
                    ("unique", c.is_unique or c.is_ak),
                    ("not null", not c.is_nullable or c.is_pk),
                    ("identity", c.is_identity),
                )
                if on
            ]
            item: Dict[str, Any] = {"name": c.physical_name, "type": _col_type(c, dialect)}
            if c.logical_name and c.logical_name != c.physical_name:
                item["logical"] = c.logical_name
            if flags:
                item["flags"] = flags
            if c.description:
                item["description"] = c.description
            if c.pii_classification != "NONE":
                item["pii"] = c.pii_classification
            if c.default_value:
                item["default"] = c.default_value
            if c.check_constraint:
                item["check"] = c.check_constraint
            cols.append(item)
        t: Dict[str, Any] = {
            "id": e.id,
            "name": e.physical_name,
            "schema": e.database_schema,
            "type": e.entity_type,
            "logical": e.logical_name,
            "area": e.subject_area,
            "columns": cols,
        }
        if e.description:
            t["description"] = e.description
        if e.view_sql:
            t["view_sql"] = e.view_sql
        if e.sql_server_props.clustered_columnstore:
            t["indexes"] = ["clustered columnstore"]
        if e.snowflake_props.cluster_by:
            t["cluster_by"] = e.snowflake_props.cluster_by
        tables.append(t)
    rels = []
    ids = {e.id for e in ents}
    for r in model.relationships.values():
        if entity_ids and r.parent_entity_id not in ids and r.child_entity_id not in ids:
            continue
        p, c = by_id.get(r.parent_entity_id), by_id.get(r.child_entity_id)
        if not p or not c:
            continue
        pc = next((x.physical_name for x in p.columns if x.id == r.parent_column_id), "")
        cc = next((x.physical_name for x in c.columns if x.id == r.child_column_id), "")
        item = {
            "name": r.name,
            "parent": f"{p.physical_name}.{pc}",
            "child": f"{c.physical_name}.{cc}",
            "cardinality": r.cardinality.value,
            "type": r.rel_type.value,
        }
        if getattr(r, "description", ""):
            item["description"] = r.description
        rels.append(item)
    return {
        "model": model.name,
        "subject_areas": model.subject_areas,
        "tables": tables,
        "relationships": rels,
        "glossary_abbreviations": dict(list(model.glossary.abbreviations.items())[:200]),
    }


def catalog_text(
    model: ProjectMetamodel, dialect: str = "snowflake", entity_ids: Optional[List[str]] = None, max_chars: int = 60000
) -> str:
    txt = json.dumps(ai_catalog(model, dialect, entity_ids), separators=(",", ":"))
    return txt if len(txt) <= max_chars else txt[:max_chars] + "...(truncated)"


def scrub_row_data(model: ProjectMetamodel) -> int:
    """Remove any row-derived values from the model. Returns the number of fields cleared."""
    cleared = 0
    for e in model.entities.values():
        for c in e.columns:
            if c.profile is not None:
                if c.profile.sample_values or c.profile.min_value or c.profile.max_value:
                    cleared += 1
                c.profile.sample_values = []
                c.profile.min_value = None
                c.profile.max_value = None
                if c.profile.detected_pattern and c.profile.detected_pattern.startswith("ENUM("):
                    c.profile.detected_pattern = "ENUM"
    return cleared


def audit_path() -> Path:
    return settings.workspace_model_dir / "ai_audit.jsonl"


def record_ai_call(feature: str, provider: str, payload_chars: int, ok: bool, detail: str = "") -> None:
    try:
        with audit_path().open("a", encoding="utf-8") as fh:
            fh.write(
                json.dumps(
                    {
                        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
                        "feature": feature,
                        "provider": provider,
                        "payload_chars": payload_chars,
                        "ok": ok,
                        "data_classes": ["schema metadata"],
                        "detail": detail[:200],
                    }
                )
                + "\n"
            )
    except Exception:
        pass


def read_audit(limit: int = 100) -> List[Dict[str, Any]]:
    p = audit_path()
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines()[-limit:]:
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return list(reversed(out))
