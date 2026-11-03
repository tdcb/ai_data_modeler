"""Generate / extend a data model from unstructured context (notes, transcripts, briefs, DDL, diagrams)."""

from __future__ import annotations

import re
import uuid
from typing import Any, Dict, List, Optional, Tuple

from ..agent.mutation_engine import HEADER_PALETTE
from ..metamodel.schema import (
    Cardinality,
    ColumnModel,
    EntityModel,
    EntityPosition,
    ProjectMetamodel,
    RelationshipModel,
    RelationshipType,
)
from ..reverse_eng.ddl_parser import _map_cross_dialect_types
from .privacy import catalog_text
from .providers import LLMError, Provider
from .textmodel import extract_spec, finalize, humanize, snake

GEN_SYSTEM = """You are a senior data architect. Turn the user's unstructured project context (meeting notes,
transcripts, briefs, requirements, diagrams, DDL) into a normalized relational data model (3NF unless the context
asks for dimensional/star schema). Reuse tables that already exist in the current model instead of duplicating
them. Use UPPER_SNAKE_CASE physical names, generic SQL types (BIGINT, INT, DECIMAL(p,s), VARCHAR(n), DATE,
TIMESTAMP, BOOLEAN), one primary key per table, and write a one-sentence business description for every table
and column.
Return JSON exactly in this shape:
{"summary": "markdown summary of the model and assumptions",
 "tables": [{"name": "CUSTOMER", "logical_name": "Customer", "description": "...", "subject_area": "Sales",
   "columns": [{"name": "CUSTOMER_ID", "type": "BIGINT", "pk": true, "nullable": false, "unique": false,
                "description": "..."}]}],
 "relationships": [{"parent": "CUSTOMER", "parent_column": "CUSTOMER_ID", "child": "ORDERS",
   "child_column": "CUSTOMER_ID", "cardinality": "one_to_many", "description": "A customer places orders."}]}"""


def generate_spec(
    provider: Provider,
    text: str,
    model: ProjectMetamodel,
    subject_area: str = "Core",
    images: Optional[list] = None,
    instructions: str = "",
) -> Dict[str, Any]:
    warnings: List[str] = []
    if not provider.is_offline:
        prompt = (
            f"Current model (metadata only):\n{catalog_text(model, max_chars=20000)}\n\n"
            f"Default subject area: {subject_area}\n"
            + (f"Extra instructions: {instructions}\n" if instructions else "")
            + f"\nProject context:\n{text[:60000]}"
        )
        try:
            spec = provider.complete_json(prompt, GEN_SYSTEM, images)
            if isinstance(spec, dict) and spec.get("tables"):
                spec.setdefault("relationships", [])
                for t in spec["tables"]:
                    t["name"] = snake(t.get("name", ""))
                    t["columns"] = [
                        dict(c, name=snake(c.get("name", ""))) for c in t.get("columns", []) if c.get("name")
                    ]
                spec = finalize(spec, subject_area)
                spec["source"] = provider.label
                spec["warnings"] = warnings
                return spec
            warnings.append(f"{provider.label} returned no tables; used the offline extractor instead.")
        except LLMError as e:
            warnings.append(f"{provider.label} failed ({e}); used the offline extractor instead.")
    spec = extract_spec(text, subject_area)
    spec["source"] = "Built-in offline extractor"
    spec["summary"] = (
        f"Extracted **{len(spec['tables'])}** table(s) and **{len(spec['relationships'])}** "
        f"relationship(s) from the context ({', '.join(spec.get('detected_formats') or []) or 'no structure found'})."
    )
    spec["warnings"] = warnings
    return spec


def diff_spec(model: ProjectMetamodel, spec: Dict[str, Any]) -> Dict[str, Any]:
    existing = {e.physical_name.upper(): e for e in model.entities.values()}
    new_tables, changed = [], []
    for t in spec.get("tables", []):
        e = existing.get(t["name"])
        if not e:
            new_tables.append(t["name"])
            continue
        have = {c.physical_name.upper() for c in e.columns}
        added = [c["name"] for c in t["columns"] if c["name"] not in have]
        if added:
            changed.append({"table": t["name"], "new_columns": added})
    return {"new_tables": new_tables, "extended_tables": changed, "relationships": len(spec.get("relationships", []))}


def _types(raw: str) -> Tuple[str, str, str]:
    t = (raw or "VARCHAR(255)").upper().strip()
    if t == "BIGINT":
        return ("NUMBER(38,0)", "BIGINT", "NUMBER(19,0)")
    if t == "TIMESTAMP":
        return ("TIMESTAMP_NTZ(9)", "DATETIME2(7)", "TIMESTAMP(6)")
    return _map_cross_dialect_types(t)


def _column(table: str, c: Dict[str, Any]) -> ColumnModel:
    sf, ss, ora = _types(c.get("type", ""))
    name = snake(c["name"])
    low = name.lower()
    pii = c.get("pii") or (
        "RESTRICTED_PII" if re.search(r"email|ssn|tax_id|phone|mobile|passport|dob|birth", low) else "NONE"
    )
    pk = bool(c.get("pk"))
    return ColumnModel(
        id=f"col-{table.lower()}-{low}-{uuid.uuid4().hex[:4]}",
        logical_name=c.get("logical_name") or humanize(name),
        physical_name=name,
        data_type_snowflake=sf,
        data_type_sql_server=ss,
        data_type_oracle=ora,
        is_pk=pk,
        is_fk=bool(c.get("fk")),
        is_nullable=False if pk else bool(c.get("nullable", True)),
        is_unique=bool(c.get("unique")),
        description=c.get("description", ""),
        pii_classification=pii,
        metadata_status="AUTO_GENERATED",
        dbt_tests=["unique", "not_null"] if pk else [],
    )


_CARD = {
    "one_to_one": Cardinality.ONE_TO_ONE,
    "one_to_many": Cardinality.ONE_TO_MANY,
    "zero_to_one": Cardinality.ZERO_TO_ONE,
    "zero_to_many": Cardinality.ZERO_TO_MANY,
    "many_to_one": Cardinality.ONE_TO_MANY,
    "many_to_many": Cardinality.ONE_TO_MANY,
}


def to_cardinality(raw: str) -> Cardinality:
    raw = str(raw or "").strip().lower()
    if raw.upper() in Cardinality._value2member_map_:
        return Cardinality(raw.upper())
    return _CARD.get(raw.replace("-", "_").replace(" ", "_"), Cardinality.ONE_TO_MANY)


def apply_spec(model: ProjectMetamodel, spec: Dict[str, Any]) -> List[str]:
    """Merge a generated spec into the model in place (new tables + missing columns + relationships)."""
    log: List[str] = []
    by_name = {e.physical_name.upper(): e for e in model.entities.values()}
    max_y = max((e.position.y for e in model.entities.values()), default=-380.0)
    base_y = max_y + 420 if model.entities else 100.0
    n_new = 0
    for t in spec.get("tables", []):
        name = snake(t["name"])
        sa = t.get("subject_area") or "Core"
        if sa not in model.subject_areas:
            model.subject_areas.append(sa)
        ent = by_name.get(name)
        if ent:
            have = {c.physical_name.upper() for c in ent.columns}
            added = [c for c in t.get("columns", []) if snake(c["name"]) not in have]
            for c in added:
                col = _column(name, c)
                col.is_pk = False
                ent.columns.append(col)
            if not ent.description and t.get("description"):
                ent.description = t["description"]
            if added:
                log.append(f"Extended `{name}` with {len(added)} column(s)")
            continue
        ent = EntityModel(
            id=f"ent-{name.lower()}-{uuid.uuid4().hex[:4]}",
            physical_name=name,
            logical_name=t.get("logical_name") or humanize(name),
            description=t.get("description", ""),
            subject_area=sa,
            metadata_status="AUTO_GENERATED",
            modeling_stereotype="FACT_TRANSACTION" if name.startswith(("FCT_", "FACT_")) else "DIM_SCD1",
            header_color=HEADER_PALETTE[len(model.entities) % len(HEADER_PALETTE)],
            position=EntityPosition(x=100.0 + (n_new % 4) * 400.0, y=base_y + (n_new // 4) * 380.0),
            columns=[_column(name, c) for c in t.get("columns", [])],
        )
        pk = next((c for c in ent.columns if c.is_pk), None)
        ent.dbt_unique_key = pk.physical_name if pk else None
        model.entities[ent.id] = ent
        by_name[name] = ent
        n_new += 1
        log.append(f"Added table `{name}` ({len(ent.columns)} columns)")
    for r in spec.get("relationships", []):
        p, c = by_name.get(snake(r["parent"])), by_name.get(snake(r["child"]))
        if not p or not c:
            continue
        pc = next((x for x in p.columns if x.physical_name.upper() == snake(r.get("parent_column", ""))), None) or next(
            (x for x in p.columns if x.is_pk), None
        )
        cc = next((x for x in c.columns if x.physical_name.upper() == snake(r.get("child_column", ""))), None)
        if not pc or not cc:
            continue
        if any(x.parent_column_id == pc.id and x.child_column_id == cc.id for x in model.relationships.values()):
            continue
        cc.is_fk = True
        card = r.get("cardinality", "one_to_many")
        rel = RelationshipModel(
            id=f"rel-{uuid.uuid4().hex[:8]}",
            name=r.get("name") or f"FK_{c.physical_name}_{p.physical_name}",
            parent_entity_id=p.id,
            child_entity_id=c.id,
            parent_column_id=pc.id,
            child_column_id=cc.id,
            cardinality=to_cardinality(card),
            rel_type=RelationshipType.IDENTIFYING if cc.is_pk else RelationshipType.NON_IDENTIFYING,
            is_mandatory=not cc.is_nullable,
            description=r.get("description", ""),
        )
        model.relationships[rel.id] = rel
        log.append(f"Linked `{p.physical_name}.{pc.physical_name}` -> `{c.physical_name}.{cc.physical_name}`")
    return log
