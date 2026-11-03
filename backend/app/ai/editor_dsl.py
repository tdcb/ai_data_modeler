"""Editor DSL: a DBML-style text view of the model that round-trips into the canonical metamodel.

    Table CORE.DIM_CUSTOMER [area: "Core", logical: "Customer"] {
      CUST_ID NUMBER(38,0) [pk, not null, note: "Surrogate key"]
      EMAIL VARCHAR(320) [unique, pii: RESTRICTED_PII]
      Note: "Conformed customer dimension"
    }
    Ref FK_ORDERS_CUSTOMER: DIM_CUSTOMER.CUST_ID < FCT_ORDERS.CUST_ID [1:N]

Tables/columns are matched by physical name so ids, positions and all other properties survive edits.
Views are shown read-only as comments and are never dropped by the editor.
"""

from __future__ import annotations

import re
import uuid
from typing import Any, Dict, List, Tuple

from ..agent.mutation_engine import HEADER_PALETTE
from ..metamodel.schema import (
    ColumnModel,
    EntityModel,
    EntityPosition,
    ProjectMetamodel,
    RelationshipModel,
    RelationshipType,
)
from ..reverse_eng.ddl_parser import _map_cross_dialect_types
from .generator import to_cardinality
from .textmodel import humanize

TYPE_FIELD = {"snowflake": "data_type_snowflake", "sql_server": "data_type_sql_server", "oracle": "data_type_oracle"}


def _q(s: str) -> str:
    return '"' + (s or "").replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ") + '"'


def _editable_rel(model: ProjectMetamodel, r: RelationshipModel) -> bool:
    """Relationships between two tables whose columns resolve; others (lineage to views, dangling) are preserved."""
    p, c = model.entities.get(r.parent_entity_id), model.entities.get(r.child_entity_id)
    return bool(
        p
        and c
        and p.entity_type == "table"
        and c.entity_type == "table"
        and any(x.id == r.parent_column_id for x in p.columns)
        and any(x.id == r.child_column_id for x in c.columns)
    )


def render(model: ProjectMetamodel, dialect: str = "snowflake") -> str:
    tf = TYPE_FIELD.get(dialect, "data_type_snowflake")
    out = [
        f"// {model.name} v{model.version} — types shown for {dialect}. Edit and press Apply (Ctrl/Cmd+S).",
        '// Column flags: pk, not null, unique, identity, default: <expr>, pii: <class>, note: "..."',
        "",
    ]
    by_id = model.entities
    for e in sorted(model.entities.values(), key=lambda x: (x.subject_area, x.physical_name)):
        if e.entity_type != "table":
            out.append(
                f"// {e.entity_type.replace('_', ' ')} {e.database_schema}.{e.physical_name} "
                f"({len(e.columns)} columns) — edit its SQL in the Inspector"
            )
            out.append("")
            continue
        attrs = [f"area: {_q(e.subject_area)}"]
        if e.logical_name and e.logical_name != humanize(e.physical_name):
            attrs.append(f"logical: {_q(e.logical_name)}")
        out.append(f"Table {e.database_schema}.{e.physical_name} [{', '.join(attrs)}] {{")
        width = max((len(c.physical_name) for c in e.columns), default=4)
        for c in e.columns:
            flags = []
            if c.is_pk:
                flags.append("pk")
            elif not c.is_nullable:
                flags.append("not null")
            if c.is_unique and not c.is_pk:
                flags.append("unique")
            if c.is_identity:
                flags.append("identity")
            if c.default_value:
                flags.append(f"default: {_q(c.default_value)}")
            if c.pii_classification != "NONE":
                flags.append(f"pii: {c.pii_classification}")
            if c.description:
                flags.append(f"note: {_q(c.description)}")
            out.append(
                f"  {c.physical_name.ljust(width)} {getattr(c, tf)}" + (f" [{', '.join(flags)}]" if flags else "")
            )
        if e.description:
            out.append(f"  Note: {_q(e.description)}")
        out.append("}")
        out.append("")
    for r in model.relationships.values():
        if not _editable_rel(model, r):
            continue
        p, c = by_id[r.parent_entity_id], by_id[r.child_entity_id]
        pc = next(x.physical_name for x in p.columns if x.id == r.parent_column_id)
        cc = next(x.physical_name for x in c.columns if x.id == r.child_column_id)
        extra = (
            [r.cardinality.value]
            + ([r.rel_type.value] if r.rel_type != RelationshipType.NON_IDENTIFYING else [])
            + ([] if r.is_mandatory else ["optional"])
            + ([f"note: {_q(r.description)}"] if r.description else [])
        )
        out.append(f"Ref {r.name}: {p.physical_name}.{pc} < {c.physical_name}.{cc} [{', '.join(extra)}]")
    return "\n".join(out).rstrip() + "\n"


_STR = r'"(?:[^"\\]|\\.)*"'


def _unq(s: str) -> str:
    s = s.strip()
    if s.startswith('"') and s.endswith('"'):
        return re.sub(r"\\(.)", r"\1", s[1:-1])
    return s


def _split_attrs(s: str) -> List[str]:
    return [p.strip() for p in re.findall(rf"(?:[^,\"]|{_STR})+", s) if p.strip()]


def _kv(attrs: List[str]) -> Tuple[set, Dict[str, str]]:
    flags, kv = set(), {}
    for a in attrs:
        m = re.match(r"(\w[\w ]*?)\s*:\s*(.+)$", a, re.S)
        if m:
            kv[m.group(1).strip().lower()] = _unq(m.group(2))
        else:
            flags.add(a.lower())
    return flags, kv


def parse(text: str) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    tables: List[Dict[str, Any]] = []
    refs: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    cur = None
    for i, raw in enumerate(text.splitlines(), 1):
        ln = re.sub(r"\s+//.*$", "", raw).strip() if '"' not in raw else raw.strip()
        if not ln or ln.startswith("//"):
            continue
        m = re.match(r"Table\s+(?:([\w$]+)\.)?([\w$]+)\s*(?:\[(.*)\])?\s*\{\s*$", ln, re.I)
        if m:
            if cur:
                errors.append({"line": i, "message": f"Table {cur['name']} is missing a closing '}}'"})
            flags, kv = _kv(_split_attrs(m.group(3) or ""))
            cur = {
                "schema": m.group(1),
                "name": m.group(2).upper(),
                "area": kv.get("area"),
                "logical": kv.get("logical"),
                "note": None,
                "columns": [],
                "line": i,
            }
            if any(t["name"] == cur["name"] for t in tables):
                errors.append({"line": i, "message": f"Duplicate table {cur['name']}"})
            tables.append(cur)
            continue
        if ln == "}":
            if not cur:
                errors.append({"line": i, "message": "Unexpected '}'"})
            cur = None
            continue
        m = re.match(
            r"Ref(?:\s+([\w$]+))?\s*:\s*([\w$]+)\.([\w$]+)\s*([<>-])\s*([\w$]+)\.([\w$]+)\s*(?:\[(.*)\])?$", ln, re.I
        )
        if m and not cur:
            flags, kv = _kv(_split_attrs(m.group(7) or ""))
            a, b = (m.group(2), m.group(3)), (m.group(5), m.group(6))
            parent, child = (a, b) if m.group(4) in "<-" else (b, a)
            card = next((f for f in flags if re.match(r"^[01]:[1n]$", f)), "1:n" if m.group(4) != "-" else "1:1")
            refs.append(
                {
                    "name": m.group(1),
                    "parent": parent[0].upper(),
                    "parent_column": parent[1].upper(),
                    "child": child[0].upper(),
                    "child_column": child[1].upper(),
                    "cardinality": card.upper(),
                    "identifying": "identifying" in flags,
                    "optional": "optional" in flags,
                    "note": kv.get("note"),
                    "line": i,
                }
            )
            continue
        if cur:
            m = re.match(rf"Note\s*:\s*({_STR}|'.*')\s*$", ln, re.I)
            if m:
                cur["note"] = _unq(m.group(1).replace("'", '"') if m.group(1).startswith("'") else m.group(1))
                continue
            m = re.match(r"([\w$]+)\s+([A-Za-z_][\w ]*(?:\([\d\s,A-Za-z]*\))?)\s*(?:\[(.*)\])?\s*$", ln)
            if not m:
                errors.append({"line": i, "message": f"Cannot parse column definition: {ln[:60]}"})
                continue
            flags, kv = _kv(_split_attrs(m.group(3) or ""))
            name = m.group(1).upper()
            if any(c["name"] == name for c in cur["columns"]):
                errors.append({"line": i, "message": f"Duplicate column {cur['name']}.{name}"})
            cur["columns"].append(
                {
                    "name": name,
                    "type": m.group(2).strip().upper(),
                    "pk": "pk" in flags or "primary key" in flags,
                    "not_null": "not null" in flags,
                    "unique": "unique" in flags,
                    "identity": "identity" in flags,
                    "default": kv.get("default"),
                    "pii": kv.get("pii", "NONE").upper(),
                    "note": kv.get("note"),
                    "line": i,
                }
            )
            continue
        errors.append({"line": i, "message": f"Unrecognised statement: {ln[:60]}"})
    if cur:
        errors.append({"line": cur["line"], "message": f"Table {cur['name']} is missing a closing '}}'"})
    names = {t["name"]: {c["name"] for c in t["columns"]} for t in tables}
    for r in refs:
        for side in ("parent", "child"):
            if r[side] in names and r[f"{side}_column"] not in names[r[side]]:
                errors.append({"line": r["line"], "message": f"Unknown column {r[side]}.{r[side + '_column']}"})
    return {"tables": tables, "refs": refs}, errors


PII = {"NONE", "INTERNAL", "CONFIDENTIAL", "RESTRICTED_PII"}


def apply(model: ProjectMetamodel, text: str, dialect: str = "snowflake") -> Dict[str, Any]:
    parsed, errors = parse(text)
    if errors:
        return {"ok": False, "errors": errors, "changes": []}
    tf = TYPE_FIELD.get(dialect, "data_type_snowflake")
    idx = {"snowflake": 0, "sql_server": 1, "oracle": 2}.get(dialect, 0)
    new = model.model_copy(deep=True)
    changes: List[str] = []
    by_name = {e.physical_name.upper(): e for e in new.entities.values()}
    seen = set()
    for t in parsed["tables"]:
        seen.add(t["name"])
        e = by_name.get(t["name"])
        if not e:
            n = len(new.entities)
            e = EntityModel(
                id=f"ent-{t['name'].lower()}-{uuid.uuid4().hex[:4]}",
                physical_name=t["name"],
                logical_name=t["logical"] or humanize(t["name"]),
                header_color=HEADER_PALETTE[n % len(HEADER_PALETTE)],
                position=EntityPosition(x=100.0 + (n % 4) * 400.0, y=100.0 + (n // 4) * 380.0),
            )
            new.entities[e.id] = e
            by_name[t["name"]] = e
            changes.append(f"Added table {t['name']}")
        if t["schema"]:
            e.database_schema = t["schema"].upper()
        if t["area"]:
            e.subject_area = t["area"]
            if t["area"] not in new.subject_areas:
                new.subject_areas.append(t["area"])
        if t["logical"]:
            e.logical_name = t["logical"]
        e.description = t["note"] or ""
        old_cols = {c.physical_name.upper(): c for c in e.columns}
        cols: List[ColumnModel] = []
        for c in t["columns"]:
            col = old_cols.get(c["name"])
            if not col:
                col = ColumnModel(
                    id=f"col-{t['name'].lower()}-{c['name'].lower()}-{uuid.uuid4().hex[:4]}",
                    physical_name=c["name"],
                    logical_name=humanize(c["name"]),
                )
                changes.append(f"Added column {t['name']}.{c['name']}")
            if getattr(col, tf).upper() != c["type"]:
                mapped = list(_map_cross_dialect_types(c["type"]))
                mapped[idx] = c["type"]
                if col.physical_name in old_cols:
                    changes.append(f"Changed type of {t['name']}.{c['name']} to {c['type']}")
                col.data_type_snowflake, col.data_type_sql_server, col.data_type_oracle = mapped
            col.is_pk = c["pk"]
            col.is_nullable = not (c["pk"] or c["not_null"])
            col.is_unique = c["unique"] or c["pk"]
            col.is_identity = c["identity"]
            col.default_value = c["default"]
            col.pii_classification = c["pii"] if c["pii"] in PII else "NONE"
            col.description = c["note"] or ""
            cols.append(col)
        for gone in set(old_cols) - {c["name"] for c in t["columns"]}:
            changes.append(f"Dropped column {t['name']}.{gone}")
        e.columns = cols
    for e in list(new.entities.values()):
        if e.entity_type == "table" and e.physical_name.upper() not in seen:
            del new.entities[e.id]
            changes.append(f"Dropped table {e.physical_name}")
    col_ids = {c.id: (e, c) for e in new.entities.values() for c in e.columns}
    by_name = {e.physical_name.upper(): e for e in new.entities.values()}
    keep: Dict[str, RelationshipModel] = {}
    old_by_key = {
        (r.parent_column_id, r.child_column_id): r
        for r in new.relationships.values()
        if r.parent_column_id in col_ids and r.child_column_id in col_ids
    }
    for _e, c in col_ids.values():
        c.is_fk = False
    for r in parsed["refs"]:
        p, ch = by_name.get(r["parent"]), by_name.get(r["child"])
        pc = next((x for x in p.columns if x.physical_name.upper() == r["parent_column"]), None) if p else None
        cc = next((x for x in ch.columns if x.physical_name.upper() == r["child_column"]), None) if ch else None
        if not pc or not cc:
            continue
        rel = old_by_key.get((pc.id, cc.id))
        if not rel:
            rel = RelationshipModel(
                id=f"rel-{uuid.uuid4().hex[:8]}",
                name=r["name"] or f"FK_{r['child']}_{r['parent']}",
                parent_entity_id=p.id,
                child_entity_id=ch.id,
                parent_column_id=pc.id,
                child_column_id=cc.id,
            )
            changes.append(f"Added relationship {rel.name}")
        if r["name"]:
            rel.name = r["name"]
        rel.cardinality = to_cardinality(r["cardinality"])
        rel.rel_type = (
            RelationshipType.IDENTIFYING
            if r["identifying"]
            else (
                rel.rel_type if rel.rel_type == RelationshipType.UPSTREAM_LINEAGE else RelationshipType.NON_IDENTIFYING
            )
        )
        rel.is_mandatory = not r["optional"]
        rel.description = r["note"] or ""
        cc.is_fk = True
        keep[rel.id] = rel
    for rid, r in new.relationships.items():
        if rid in keep:
            continue
        if not _editable_rel(model, r):
            if r.parent_entity_id in new.entities and r.child_entity_id in new.entities:
                keep[rid] = r
            continue
        changes.append(f"Dropped relationship {r.name}")
    new.relationships = keep
    return {"ok": True, "errors": [], "changes": changes, "project": new}
