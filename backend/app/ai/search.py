"""Natural-language schema search over metadata (tables, columns, relationships, descriptions, glossary)."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from ..metamodel.schema import ProjectMetamodel
from .privacy import catalog_text
from .providers import LLMError, Provider
from .textmodel import singular

SYNONYMS = {
    "customer": ["client", "cust", "buyer", "account", "party"],
    "client": ["customer"],
    "order": ["purchase", "sale", "transaction", "ord"],
    "product": ["item", "sku", "prod", "article"],
    "employee": ["staff", "worker", "emp", "personnel"],
    "address": ["location", "addr", "postcode", "zip"],
    "amount": ["amt", "value", "total", "price", "cost"],
    "date": ["dt", "day", "timestamp", "time"],
    "email": ["mail", "e-mail"],
    "phone": ["telephone", "mobile", "tel"],
    "identifier": ["id", "key"],
    "money": ["amount", "price", "cost", "revenue", "amt"],
    "policy": ["plcy"],
    "claim": ["clm"],
    "supplier": ["vendor", "supp"],
    "invoice": ["bill", "inv"],
    "payment": ["pay", "pmt"],
}
STOPWORDS = {
    "show",
    "me",
    "find",
    "list",
    "all",
    "the",
    "a",
    "an",
    "which",
    "what",
    "where",
    "is",
    "are",
    "do",
    "does",
    "we",
    "have",
    "store",
    "stored",
    "tables",
    "table",
    "columns",
    "column",
    "fields",
    "field",
    "with",
    "of",
    "for",
    "in",
    "that",
    "contain",
    "contains",
    "to",
    "and",
    "or",
    "any",
    "our",
    "about",
    "related",
    "kept",
    "held",
    "there",
    "i",
    "can",
    "get",
    "how",
    "by",
    "on",
    "data",
    "info",
}


def _tokens(text: str) -> List[str]:
    return [singular(t) for t in re.findall(r"[a-z0-9]+", text.lower()) if t not in STOPWORDS and len(t) > 1]


def _expand(model: ProjectMetamodel, toks: List[str]) -> Dict[str, float]:
    terms: Dict[str, float] = {}
    abbr = {k.lower(): v.lower() for k, v in model.glossary.abbreviations.items()}
    inv = {v: k for k, v in abbr.items()}
    for t in toks:
        terms[t] = 1.0
        for s in SYNONYMS.get(t, []):
            terms.setdefault(singular(s), 0.6)
        if t in abbr:
            terms.setdefault(abbr[t], 0.8)
        if t in inv:
            terms.setdefault(inv[t], 0.8)
    return terms


def _score(text: str, terms: Dict[str, float]) -> float:
    words = set(singular(w) for w in re.findall(r"[a-z0-9]+", text.lower().replace("_", " ")))
    hay = text.lower()
    s = 0.0
    for t, w in terms.items():
        if t in words:
            s += w
        elif len(t) > 3 and t in hay:
            s += w * 0.5
    return s


def _structural(q: str) -> Dict[str, bool]:
    ql = q.lower()
    return {
        "pii": bool(re.search(r"\b(pii|personal|sensitive|gdpr|private|privacy)\b", ql)),
        "pk": bool(re.search(r"primary key|\bpks?\b", ql)),
        "fk": bool(re.search(r"foreign key|\bfks?\b|references?\b", ql)),
        "undocumented": bool(
            re.search(r"undocumented|no description|without (a )?description|missing description", ql)
        ),
        "nullable": bool(re.search(r"\bnullable\b|allow nulls?", ql)),
        "views": bool(re.search(r"\bviews?\b", ql)),
        "orphan": bool(re.search(r"orphan|isolated|no relationship|unconnected", ql)),
    }


_TYPE_WORDS = {
    "date": r"DATE|TIME",
    "timestamp": r"TIME",
    "text": r"CHAR|TEXT|STRING",
    "string": r"CHAR|TEXT|STRING",
    "numeric": r"NUM|DEC|INT|FLOAT",
    "number": r"NUM|DEC|INT|FLOAT",
    "boolean": r"BOOL|BIT",
    "decimal": r"DEC|NUMBER\(\d+,[1-9]",
}


def offline_search(model: ProjectMetamodel, query: str, limit: int = 40) -> Dict[str, Any]:
    flags = _structural(query)
    toks = _tokens(query)
    type_re = next((v for k, v in _TYPE_WORDS.items() if re.search(rf"\b{k}s?\b", query.lower())), None)
    noise = {
        "pii",
        "personal",
        "sensitive",
        "primary",
        "foreign",
        "key",
        "pk",
        "fk",
        "undocumented",
        "description",
        "nullable",
        "view",
        "orphan",
        "missing",
        "without",
        "no",
        "gdpr",
    } | set(_TYPE_WORDS)
    terms = _expand(model, [t for t in toks if t not in noise])
    results: List[Dict[str, Any]] = []
    linked = {r.parent_entity_id for r in model.relationships.values()} | {
        r.child_entity_id for r in model.relationships.values()
    }
    for e in model.entities.values():
        etext = f"{e.physical_name} {e.logical_name} {e.description} {' '.join(e.tags)} {e.subject_area}"
        es = _score(etext, terms) * 1.5 if terms else 0.0
        ok_entity = (not flags["views"] or e.entity_type != "table") and (not flags["orphan"] or e.id not in linked)
        col_hits = []
        for c in e.columns:
            cs = (
                _score(f"{c.physical_name} {c.logical_name} {c.description} {' '.join(c.tags)}", terms)
                if terms
                else 0.0
            )
            reasons = []
            if flags["pii"] and c.pii_classification != "NONE":
                cs += 2
                reasons.append(c.pii_classification)
            if flags["pk"] and c.is_pk:
                cs += 1.5
                reasons.append("primary key")
            if flags["fk"] and c.is_fk:
                cs += 1.5
                reasons.append("foreign key")
            if flags["undocumented"] and not c.description.strip():
                cs += 1.5
                reasons.append("no description")
            if flags["nullable"] and c.is_nullable:
                cs += 1
                reasons.append("nullable")
            if type_re and re.search(type_re, c.data_type_snowflake.upper()):
                cs += 1.5
                reasons.append(c.data_type_snowflake)
            structural = any(flags[k] for k in ("pii", "pk", "fk", "undocumented", "nullable")) or type_re
            if structural and not reasons:
                cs = 0
            if (
                terms
                and structural
                and reasons
                and es == 0
                and _score(c.physical_name + " " + c.logical_name, terms) == 0
            ):
                cs = 0
            if cs > 0:
                col_hits.append((cs, c, reasons))
        if ok_entity and (flags["views"] or flags["orphan"]) and not terms:
            es = max(es, 1.0)
        if flags["undocumented"] and not e.description.strip():
            es = max(es, 1.0)
        if es > 0 and ok_entity:
            results.append(
                {
                    "kind": "entity",
                    "entity_id": e.id,
                    "title": e.physical_name,
                    "subtitle": e.logical_name,
                    "detail": e.description,
                    "score": round(es, 2),
                    "reason": "name/description match" if terms else "structural filter",
                }
            )
        for cs, c, reasons in col_hits:
            if not ok_entity:
                continue
            results.append(
                {
                    "kind": "column",
                    "entity_id": e.id,
                    "column_id": c.id,
                    "title": f"{e.physical_name}.{c.physical_name}",
                    "subtitle": f"{c.logical_name} · {c.data_type_snowflake}",
                    "detail": c.description,
                    "score": round(cs, 2),
                    "reason": ", ".join(reasons) or "name/description match",
                }
            )
    if terms or flags["fk"]:
        for r in model.relationships.values():
            p, c = model.entities.get(r.parent_entity_id), model.entities.get(r.child_entity_id)
            if not p or not c:
                continue
            rs = _score(
                f"{r.name} {p.physical_name} {p.logical_name} {c.physical_name} {c.logical_name} {r.description}", terms
            )
            if rs >= 1.0 or (flags["fk"] and not terms):
                results.append(
                    {
                        "kind": "relationship",
                        "relationship_id": r.id,
                        "entity_id": c.id,
                        "title": r.name,
                        "subtitle": f"{p.physical_name} → {c.physical_name}",
                        "detail": r.description,
                        "score": round(rs * 0.8 or 0.5, 2),
                        "reason": "connects matching tables",
                    }
                )
    results.sort(key=lambda x: -x["score"])
    if results and terms:
        top = results[0]["score"]
        results = [x for x in results if x["score"] >= top * 0.35]
    results = results[:limit]
    ents = sorted({x["title"].split(".")[0] for x in results if x["kind"] != "relationship"})
    answer = (
        (
            f"Found **{len(results)}** match(es) across **{len(ents)}** table(s): "
            + ", ".join(f"`{t}`" for t in ents[:12])
        )
        if results
        else "No matching metadata found."
    )
    return {
        "answer": answer,
        "results": results,
        "interpretation": {
            "terms": terms,
            "filters": [k for k, v in flags.items() if v] + ([f"type~{type_re}"] if type_re else []),
        },
    }


SEARCH_SYSTEM = """You answer questions about a database schema using ONLY the metadata catalogue provided (no row
data exists). Return JSON: {"answer": "concise markdown answer", "matches": [{"table": "TABLE_NAME",
"column": "COLUMN_NAME or null", "reason": "why it matches"}]}. Only reference tables/columns that exist."""


def search(model: ProjectMetamodel, query: str, provider: Optional[Provider] = None) -> Dict[str, Any]:
    base = offline_search(model, query)
    if not provider or provider.is_offline:
        base["source"] = "Built-in semantic matcher"
        return base
    try:
        out = provider.complete_json(f"Catalogue:\n{catalog_text(model)}\n\nQuestion: {query}", SEARCH_SYSTEM)
    except LLMError as e:
        base["source"] = "Built-in semantic matcher"
        base["warnings"] = [f"{provider.label} failed: {e}"]
        return base
    by_name = {e.physical_name.upper(): e for e in model.entities.values()}
    results = []
    for m in (out.get("matches") or []) if isinstance(out, dict) else []:
        e = by_name.get(str(m.get("table", "")).upper())
        if not e:
            continue
        col = next((c for c in e.columns if c.physical_name.upper() == str(m.get("column") or "").upper()), None)
        if col:
            results.append(
                {
                    "kind": "column",
                    "entity_id": e.id,
                    "column_id": col.id,
                    "title": f"{e.physical_name}.{col.physical_name}",
                    "subtitle": f"{col.logical_name} · {col.data_type_snowflake}",
                    "detail": col.description,
                    "score": 1.0,
                    "reason": m.get("reason", ""),
                }
            )
        else:
            results.append(
                {
                    "kind": "entity",
                    "entity_id": e.id,
                    "title": e.physical_name,
                    "subtitle": e.logical_name,
                    "detail": e.description,
                    "score": 1.0,
                    "reason": m.get("reason", ""),
                }
            )
    return {
        "answer": out.get("answer", "") if isinstance(out, dict) else "",
        "results": results or base["results"],
        "source": provider.label,
        "interpretation": base["interpretation"],
    }
