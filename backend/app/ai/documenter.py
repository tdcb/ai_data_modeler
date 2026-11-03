"""AI documentation: proposed descriptions for tables, columns and relationships + on-demand explanations."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from ..metamodel.glossary import physical_to_logical_guess
from ..metamodel.schema import ProjectMetamodel
from .privacy import ai_catalog, catalog_text
from .providers import LLMError, Provider

DOC_SYSTEM = """You are a data steward writing a business data dictionary. Using ONLY the metadata given (there is
no row data), write clear one or two sentence business definitions. Return JSON:
{"tables": [{"name": "TABLE", "description": "...", "columns": {"COLUMN": "..."}}],
 "relationships": {"REL_NAME": "one sentence business meaning"}}"""


def _is_placeholder(text: str) -> bool:
    t = (text or "").strip().lower()
    return (
        not t or t.endswith(" attribute.") or t.startswith(("enterprise ", "reverse-engineered", "reverse engineered"))
    )


def _offline_column(e: Any, c: Any, model: ProjectMetamodel) -> str:
    logical = (c.logical_name or physical_to_logical_guess(c.physical_name, model.glossary)).strip()
    ent = (e.logical_name or e.physical_name).strip()
    low = c.physical_name.lower()
    t = c.data_type_snowflake.upper()
    if c.is_pk:
        return f"Unique identifier of each {ent.lower()} record (primary key)."
    if c.is_fk:
        parent = next(
            (
                model.entities[r.parent_entity_id]
                for r in model.relationships.values()
                if r.child_column_id == c.id and r.parent_entity_id in model.entities
            ),
            None,
        )
        if parent:
            return f"Reference to the related {parent.logical_name.lower()} ({parent.physical_name})."
        return f"Foreign key reference used by {ent.lower()} ({logical.lower()})."
    if re.search(r"(_at|_ts|timestamp)$", low) or "TIMESTAMP" in t:
        what = logical.lower().replace(" at", "").replace("timestamp", "").strip() or "event"
        return f"Date and time when the {ent.lower()} {what} occurred."
    if re.search(r"(date|_dt)$", low) or t == "DATE":
        return f"Calendar date of the {ent.lower()} {logical.lower().replace(' date', '').strip()}."
    if re.search(r"(amt|amount|price|cost|total|fee|balance)", low):
        return f"Monetary {logical.lower()} of the {ent.lower()}."
    if re.search(r"(^is_|^has_|_ind$|_flag$|flag$)", low) or "BOOL" in t:
        what = logical.lower().replace("is ", "").replace(" indicator", "").replace(" flag", "")
        return f"Indicator of whether the {ent.lower()} is {what}."
    if re.search(r"(_cd|code|status|type)$", low):
        return f"Code classifying the {logical.lower()} of the {ent.lower()}."
    if re.search(r"(qty|quantity|count|cnt)", low):
        return f"Count of {logical.lower().replace('quantity', 'units').replace('count', '').strip()} for the {ent.lower()}."
    return f"{logical} of the {ent.lower()}."


def _offline_entity(e: Any, model: ProjectMetamodel) -> str:
    ent = (e.logical_name or e.physical_name).strip()
    parents = [
        model.entities[r.parent_entity_id].logical_name
        for r in model.relationships.values()
        if r.child_entity_id == e.id and r.parent_entity_id in model.entities
    ]
    children = [
        model.entities[r.child_entity_id].logical_name
        for r in model.relationships.values()
        if r.parent_entity_id == e.id and r.child_entity_id in model.entities
    ]
    pk = ", ".join(c.physical_name for c in e.columns if c.is_pk) or "no declared key"
    kind = "view" if e.entity_type != "table" else "table"
    s = f"Stores one record per {ent.lower()} (key: {pk})."
    if e.physical_name.upper().startswith(("FCT_", "FACT_")):
        s = f"Fact {kind} recording {ent.lower().replace('fact', '').strip()} events (grain: {pk})."
    elif e.physical_name.upper().startswith("DIM_"):
        s = f"Dimension {kind} describing each {ent.lower().replace('dimension', '').strip()} (key: {pk})."
    if parents:
        s += f" Each record belongs to {', '.join(sorted(set(parents))[:4])}."
    if children:
        s += f" Referenced by {', '.join(sorted(set(children))[:4])}."
    return s


def _offline_rel(r: Any, model: ProjectMetamodel) -> str:
    p, c = model.entities.get(r.parent_entity_id), model.entities.get(r.child_entity_id)
    if not p or not c:
        return ""
    many = r.cardinality.value.endswith("N")
    opt = "may" if not r.is_mandatory else "must"
    return (
        f"Each {c.logical_name.lower()} {opt} reference one {p.logical_name.lower()}; a {p.logical_name.lower()} "
        f"can have {'many' if many else 'one'} {c.logical_name.lower()}{'s' if many else ''}."
    )


def propose_documentation(
    model: ProjectMetamodel,
    provider: Optional[Provider] = None,
    entity_ids: Optional[List[str]] = None,
    only_missing: bool = True,
) -> Dict[str, Any]:
    ents = [e for e in model.entities.values() if not entity_ids or e.id in entity_ids]
    llm: Dict[str, Any] = {}
    warnings: List[str] = []
    source = "Built-in documenter"
    if provider and not provider.is_offline and ents:
        try:
            out = provider.complete_json(
                f"Metadata:\n{catalog_text(model, entity_ids=[e.id for e in ents])}\n\n"
                "Write definitions for every table, column and relationship above.",
                DOC_SYSTEM,
            )
            if isinstance(out, dict):
                llm = out
                source = provider.label
        except LLMError as e:
            warnings.append(f"{provider.label} failed ({e}); used the built-in documenter.")
    llm_tables = {str(t.get("name", "")).upper(): t for t in llm.get("tables", []) if isinstance(t, dict)}
    llm_rels = {str(k).upper(): v for k, v in (llm.get("relationships") or {}).items()}
    proposals: List[Dict[str, Any]] = []
    for e in ents:
        lt = llm_tables.get(e.physical_name.upper(), {})
        if not only_missing or _is_placeholder(e.description):
            proposals.append(
                {
                    "target": "entity",
                    "entity_id": e.id,
                    "label": e.physical_name,
                    "current": e.description,
                    "proposed": lt.get("description") or _offline_entity(e, model),
                }
            )
        lcols = {str(k).upper(): v for k, v in (lt.get("columns") or {}).items()}
        for c in e.columns:
            if only_missing and not _is_placeholder(c.description):
                continue
            proposals.append(
                {
                    "target": "column",
                    "entity_id": e.id,
                    "column_id": c.id,
                    "label": f"{e.physical_name}.{c.physical_name}",
                    "current": c.description,
                    "proposed": lcols.get(c.physical_name.upper()) or _offline_column(e, c, model),
                }
            )
    ids = {e.id for e in ents}
    for r in model.relationships.values():
        if (r.parent_entity_id in ids or r.child_entity_id in ids) and (not only_missing or not r.description):
            txt = llm_rels.get(r.name.upper()) or _offline_rel(r, model)
            if txt:
                proposals.append(
                    {
                        "target": "relationship",
                        "relationship_id": r.id,
                        "label": r.name,
                        "current": r.description,
                        "proposed": txt,
                    }
                )
    return {"proposals": proposals, "source": source, "warnings": warnings}


def apply_documentation(model: ProjectMetamodel, proposals: List[Dict[str, Any]]) -> int:
    n = 0
    for p in proposals:
        txt = str(p.get("proposed") or "").strip()
        if not txt:
            continue
        if p.get("target") == "relationship":
            r = model.relationships.get(p.get("relationship_id", ""))
            if r:
                r.description = txt
                n += 1
            continue
        e = model.entities.get(p.get("entity_id", ""))
        if not e:
            continue
        if p.get("target") == "entity":
            e.description, e.metadata_status = txt, "AUTO_GENERATED"
            n += 1
        else:
            c = next((x for x in e.columns if x.id == p.get("column_id")), None)
            if c:
                c.description, c.metadata_status = txt, "AUTO_GENERATED"
                n += 1
    return n


EXPLAIN_SYSTEM = """Explain the given database object to a business analyst in concise markdown: purpose, grain,
keys, important columns, how it relates to other tables, data-quality/PII considerations and example questions it
can answer. Use only the metadata provided; never invent row values."""


def explain(
    model: ProjectMetamodel,
    entity_id: Optional[str] = None,
    column_id: Optional[str] = None,
    relationship_id: Optional[str] = None,
    provider: Optional[Provider] = None,
) -> Dict[str, Any]:
    ids = [entity_id] if entity_id else []
    rel = model.relationships.get(relationship_id or "")
    if rel:
        ids = [rel.parent_entity_id, rel.child_entity_id]
    focus = ""
    e = model.entities.get(entity_id or "") if entity_id else None
    col = next((c for c in e.columns if c.id == column_id), None) if e and column_id else None
    if col:
        focus = f"Explain column {e.physical_name}.{col.physical_name}."
    elif rel:
        focus = f"Explain relationship {rel.name}."
    elif e:
        focus = f"Explain table {e.physical_name}."
    if provider and not provider.is_offline and ids:
        try:
            md = provider.complete(f"Metadata:\n{catalog_text(model, entity_ids=ids)}\n\n{focus}", EXPLAIN_SYSTEM)
            return {"markdown": md.strip(), "source": provider.label}
        except LLMError as ex:
            warn = str(ex)
        else:
            warn = ""
    else:
        warn = ""
    return {
        "markdown": _offline_explain(model, e, col, rel),
        "source": "Built-in explainer",
        "warnings": [warn] if warn else [],
    }


def _offline_explain(model: ProjectMetamodel, e: Any, col: Any, rel: Any) -> str:
    if rel:
        p, c = model.entities.get(rel.parent_entity_id), model.entities.get(rel.child_entity_id)
        return (
            f"### {rel.name}\n{rel.description or _offline_rel(rel, model)}\n\n"
            f"- **Parent:** `{p.physical_name if p else '?'}`"
            f"\n- **Child:** `{c.physical_name if c else '?'}`\n- **Cardinality:** {rel.cardinality.value}"
            f"\n- **Type:** {rel.rel_type.value}{' (mandatory)' if rel.is_mandatory else ' (optional)'}"
        )
    if not e:
        return "Select a table, column or relationship to explain."
    cat = ai_catalog(model, entity_ids=[e.id])
    t = cat["tables"][0]
    if col:
        c = next(x for x in t["columns"] if x["name"] == col.physical_name)
        return (
            f"### {e.physical_name}.{col.physical_name}\n{col.description or _offline_column(e, col, model)}\n\n"
            f"- **Type:** `{c['type']}`\n- **Flags:** {', '.join(c.get('flags', [])) or 'none'}\n"
            f"- **PII:** {col.pii_classification}\n- **Logical name:** {col.logical_name}"
        )
    lines = [
        f"### {e.physical_name} — {e.logical_name}",
        e.description or _offline_entity(e, model),
        "",
        f"- **Type:** {e.entity_type} · **Subject area:** {e.subject_area} · **Columns:** {len(e.columns)}",
        f"- **Keys:** {', '.join(c.physical_name for c in e.columns if c.is_pk) or 'none'}",
    ]
    pii = [c.physical_name for c in e.columns if c.pii_classification != "NONE"]
    if pii:
        lines.append(f"- **Sensitive columns:** {', '.join(pii)}")
    rels = [r for r in cat["relationships"]]
    if rels:
        lines.append("- **Relationships:**")
        lines += [f"  - `{r['parent']}` → `{r['child']}` ({r['cardinality']})" for r in rels]
    if e.sample_questions:
        lines.append("- **Questions it answers:** " + "; ".join(e.sample_questions[:5]))
    return "\n".join(lines)
