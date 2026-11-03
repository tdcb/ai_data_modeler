"""SQLite DDL compiler (tables, inline PK/FK constraints and views)."""

import re
from typing import List, Optional

from ..metamodel.schema import EntityModel, ProjectMetamodel


def sqlite_type(raw: str) -> str:
    t = (raw or "").upper()
    if re.search(r"INT|IDENTITY|SERIAL", t) or re.match(r"NUMBER\(\d+(,\s*0)?\)$", t):
        return "INTEGER"
    if re.search(r"NUMBER|NUMERIC|DECIMAL|MONEY", t):
        return "NUMERIC"
    if re.search(r"FLOAT|DOUBLE|REAL", t):
        return "REAL"
    if re.search(r"BOOL|BIT", t):
        return "INTEGER"
    if re.search(r"BLOB|BINARY|VARBINARY", t):
        return "BLOB"
    if re.search(r"DATE|TIME", t):
        return "TEXT"
    return "TEXT"


def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def compile_sqlite_entity(entity: EntityModel, model: ProjectMetamodel) -> str:
    name = entity.physical_name.upper()
    if entity.entity_type in ("view", "materialized_view"):
        body = (entity.view_sql or "").strip().rstrip(";")
        if not body:
            return f"-- View {name} has no SQL definition"
        if not body.upper().startswith("CREATE"):
            body = f"CREATE VIEW IF NOT EXISTS {_q(name)} AS\n{body}"
        return body + ";"
    lines: List[str] = []
    pks = [c.physical_name.upper() for c in entity.columns if c.is_pk]
    for c in entity.columns:
        parts = [f"    {_q(c.physical_name.upper())} {sqlite_type(c.data_type_snowflake or c.data_type_sql_server)}"]
        if len(pks) == 1 and c.is_pk:
            parts.append("PRIMARY KEY")
        if not c.is_nullable or c.is_pk:
            parts.append("NOT NULL")
        if (c.is_unique or c.is_ak) and not c.is_pk:
            parts.append("UNIQUE")
        if c.default_value not in (None, ""):
            parts.append(f"DEFAULT ({c.default_value})")
        if c.check_constraint:
            parts.append(f"CHECK ({c.check_constraint})")
        lines.append(" ".join(parts))
    if len(pks) > 1:
        lines.append(f"    PRIMARY KEY ({', '.join(_q(p) for p in pks)})")
    for rel in model.relationships.values():
        if rel.child_entity_id != entity.id:
            continue
        parent = model.entities.get(rel.parent_entity_id)
        if not parent:
            continue
        pc = next((c for c in parent.columns if c.id == rel.parent_column_id), None)
        cc = next((c for c in entity.columns if c.id == rel.child_column_id), None)
        if pc and cc:
            lines.append(
                f"    CONSTRAINT {_q(rel.name)} FOREIGN KEY ({_q(cc.physical_name.upper())}) "
                f"REFERENCES {_q(parent.physical_name.upper())} ({_q(pc.physical_name.upper())})"
            )
    header = f"-- {entity.logical_name}" + (f": {entity.description}" if entity.description else "")
    return f"{header}\nCREATE TABLE IF NOT EXISTS {_q(name)} (\n" + ",\n".join(lines) + "\n);"


def compile_sqlite_ddl(model: ProjectMetamodel, subject_area: Optional[str] = None) -> str:
    ents = [
        e
        for e in model.entities.values()
        if not subject_area or subject_area == "All" or e.subject_area == subject_area
    ]
    by_id = {e.id: e for e in ents}
    # Parents before children so the script runs top to bottom.
    ordered: List[EntityModel] = []
    seen: set = set()

    def visit(e: EntityModel, stack: set) -> None:
        if e.id in seen or e.id in stack:
            return
        stack.add(e.id)
        for r in model.relationships.values():
            if r.child_entity_id == e.id and r.parent_entity_id in by_id:
                visit(by_id[r.parent_entity_id], stack)
        seen.add(e.id)
        ordered.append(e)

    for e in sorted([x for x in ents if x.entity_type == "table"], key=lambda x: x.physical_name):
        visit(e, set())
    ordered += [e for e in ents if e.entity_type != "table"]
    head = ["-- SQLite DDL", f"-- Project: {model.name} (v{model.version})", "PRAGMA foreign_keys = ON;", ""]
    return "\n".join(head) + "\n\n".join(compile_sqlite_entity(e, model) for e in ordered) + "\n"
