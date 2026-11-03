"""Offline (no-LLM) extraction of a model spec from unstructured text.

Understands SQL DDL, DBML, Mermaid erDiagram, markdown tables and plain prose ("A customer has many orders.
Each order has an order date and total amount."). Output spec format (same as the LLM path):
{"tables": [{"name", "logical_name", "description", "subject_area", "columns": [{"name", "type", "pk", "nullable",
"unique", "description"}]}], "relationships": [{"parent", "parent_column", "child", "child_column", "cardinality"}]}
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

STOP = {
    "the",
    "a",
    "an",
    "each",
    "every",
    "their",
    "its",
    "his",
    "her",
    "our",
    "we",
    "they",
    "it",
    "and",
    "or",
    "of",
    "to",
    "for",
    "in",
    "on",
    "with",
    "by",
    "be",
    "can",
    "will",
    "should",
    "must",
    "may",
    "is",
    "are",
    "has",
    "have",
    "also",
    "which",
    "that",
    "this",
    "these",
    "those",
    "who",
    "one",
    "many",
    "multiple",
    "several",
    "some",
    "all",
    "system",
    "data",
    "information",
    "details",
    "record",
    "records",
    "track",
    "need",
    "needs",
    "want",
    "store",
    "stores",
    "capture",
    "keep",
    "like",
    "such",
    "as",
    "etc",
    "using",
    "from",
    "into",
    "at",
    "per",
    "more",
    "than",
    "only",
    "zero",
    "own",
    "owns",
    "given",
    "there",
    "new",
    "user story",
    "so",
    "when",
    "if",
    "then",
    "i",
}

TYPE_HINTS = [
    (r"(email)", "VARCHAR(320)"),
    (r"(phone|mobile|fax)", "VARCHAR(30)"),
    (r"(^|_)(id|key|number|no|nbr)$", "BIGINT"),
    (r"(date|_dt|_on|dob|birthday)$", "DATE"),
    (r"(_at|timestamp|time|_ts)$", "TIMESTAMP"),
    (r"(amount|amt|price|cost|total|balance|salary|fee|revenue|value|rate|tax|discount)", "DECIMAL(18,2)"),
    (r"(qty|quantity|count|cnt|age|year|num_|units|seats|capacity|rank|score|duration)", "INT"),
    (r"^(is|has|can)_|(flag|_ind|active|enabled|deleted)$", "BOOLEAN"),
    (r"(code|_cd|sku|status|type|category|currency|country|state|gender)", "VARCHAR(50)"),
    (r"(description|notes|comment|body|text|address|bio|summary)", "VARCHAR(2000)"),
    (r"(name|title|label|city)", "VARCHAR(255)"),
]


def snake(s: str) -> str:
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s.strip())
    s = re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_")
    return s.upper()


def singular(word: str) -> str:
    w = word.lower()
    if w.endswith("ies") and len(w) > 4:
        return word[:-3] + "y"
    if w.endswith(("ses", "xes", "ches", "shes")):
        return word[:-2]
    if w.endswith("s") and not w.endswith(("ss", "us", "is")) and len(w) > 3:
        return word[:-1]
    return word


def infer_type(col: str) -> str:
    low = col.lower()
    for pat, t in TYPE_HINTS:
        if re.search(pat, low):
            return t
    return "VARCHAR(255)"


def humanize(name: str) -> str:
    return " ".join(p.capitalize() for p in name.lower().split("_") if p)


def _norm_type(raw: str) -> str:
    t = (raw or "").strip().strip(",").upper()
    aliases = {
        "STRING": "VARCHAR(255)",
        "STR": "VARCHAR(255)",
        "TEXT": "VARCHAR(4000)",
        "INTEGER": "INT",
        "LONG": "BIGINT",
        "DATETIME": "TIMESTAMP",
        "BOOL": "BOOLEAN",
        "MONEY": "DECIMAL(18,2)",
        "NUMBER": "DECIMAL(38,0)",
        "FLOAT": "FLOAT",
        "UUID": "VARCHAR(36)",
        "SERIAL": "BIGINT",
    }
    return aliases.get(t, t or "VARCHAR(255)")


def _table(spec: Dict[str, Any], name: str) -> Dict[str, Any]:
    name = snake(name)
    for t in spec["tables"]:
        if t["name"] == name:
            return t
    t = {"name": name, "logical_name": humanize(name), "description": "", "columns": []}
    spec["tables"].append(t)
    return t


def _add_col(t: Dict[str, Any], name: str, typ: Optional[str] = None, **kw: Any) -> Dict[str, Any]:
    name = snake(name)
    for c in t["columns"]:
        if c["name"] == name:
            c.update({k: v for k, v in kw.items() if v})
            return c
    c = {"name": name, "type": _norm_type(typ) if typ else infer_type(name), "pk": False, "nullable": True}
    c.update(kw)
    t["columns"].append(c)
    return c


def parse_dbml(text: str, spec: Dict[str, Any]) -> bool:
    found = False
    for m in re.finditer(r"Table\s+([\w.\"]+)(?:\s+as\s+\w+)?\s*(?:\[[^\]]*\])?\s*\{(.*?)\n\}", text, re.S | re.I):
        found = True
        t = _table(spec, m.group(1).split(".")[-1].strip('"'))
        for ln in m.group(2).splitlines():
            ln = ln.strip()
            if not ln or ln.startswith(("//", "Note", "indexes", "}", "(")):
                note = re.match(r"Note\s*:\s*'(.*)'", ln)
                if note:
                    t["description"] = note.group(1)
                continue
            cm = re.match(r"\"?(\w+)\"?\s+([\w(), ]+?)\s*(\[(.*)\])?$", ln)
            if not cm:
                continue
            attrs = (cm.group(4) or "").lower()
            c = _add_col(
                t,
                cm.group(1),
                cm.group(2),
                pk="pk" in attrs or "primary key" in attrs,
                nullable=not ("not null" in attrs or "pk" in attrs),
                unique="unique" in attrs,
            )
            nm = re.search(r"note\s*:\s*'([^']*)'", cm.group(4) or "", re.I)
            if nm:
                c["description"] = nm.group(1)
            ref = re.search(r"ref\s*:\s*([<>-])\s*([\w.]+)\.(\w+)", cm.group(4) or "", re.I)
            if ref:
                _rel_from_ref(spec, t["name"], c["name"], ref.group(1), ref.group(2).split(".")[-1], ref.group(3))
    for m in re.finditer(r"Ref\s*\w*\s*:\s*([\w.]+)\.(\w+)\s*([<>-])\s*([\w.]+)\.(\w+)", text, re.I):
        found = True
        _rel_from_ref(spec, m.group(1).split(".")[-1], m.group(2), m.group(3), m.group(4).split(".")[-1], m.group(5))
    return found


def _rel_from_ref(spec, t1, c1, op, t2, c2):
    # DBML: `t1.c1 > t2.c2` means many t1 -> one t2 (t2 is parent).
    if op == "<":
        parent, pcol, child, ccol = t1, c1, t2, c2
    else:
        parent, pcol, child, ccol = t2, c2, t1, c1
    spec["relationships"].append(
        {
            "parent": snake(parent),
            "parent_column": snake(pcol),
            "child": snake(child),
            "child_column": snake(ccol),
            "cardinality": "one_to_one" if op == "-" else "one_to_many",
        }
    )


def parse_mermaid(text: str, spec: Dict[str, Any]) -> bool:
    if "erDiagram" not in text:
        return False
    for m in re.finditer(r"^\s*([\w-]+)\s*\{(.*?)\}", text, re.S | re.M):
        t = _table(spec, m.group(1))
        for ln in m.group(2).splitlines():
            parts = ln.strip().split()
            if len(parts) >= 2:
                flags = " ".join(parts[2:]).upper()
                desc = re.search(r"\"([^\"]*)\"", ln)
                _add_col(
                    t,
                    parts[1],
                    parts[0],
                    pk="PK" in flags,
                    nullable="PK" not in flags,
                    description=desc.group(1) if desc else "",
                )
    for m in re.finditer(r"([\w-]+)\s+([|}o{]{2})(--|\.\.)([|}o{]{2})\s+([\w-]+)\s*:?", text):
        left, lcard, rcard, right = m.group(1), m.group(2), m.group(4), m.group(5)
        many_right = "{" in rcard or "}" in rcard
        many_left = "{" in lcard or "}" in lcard
        if many_left and not many_right:
            left, right = right, left
        spec["relationships"].append(
            {
                "parent": snake(left),
                "child": snake(right),
                "cardinality": "one_to_many" if (many_left or many_right) else "one_to_one",
            }
        )
    return True


def parse_sql(text: str, spec: Dict[str, Any]) -> bool:
    if not re.search(r"create\s+table", text, re.I):
        return False
    from ..reverse_eng.ddl_parser import parse_ddl_to_metamodel

    try:
        ents, rels = parse_ddl_to_metamodel(text)
    except Exception:
        ents, rels = [], []
    by_id = {e.id: e for e in ents}
    for e in ents:
        t = _table(spec, e.physical_name)
        t["description"] = e.description if not e.description.startswith("Reverse") else ""
        for c in e.columns:
            _add_col(
                t,
                c.physical_name,
                c.data_type_snowflake,
                pk=c.is_pk,
                nullable=c.is_nullable,
                unique=c.is_unique,
                description=c.description if "attribute" not in c.description else "",
            )
    for r in rels:
        p, ch = by_id.get(r.parent_entity_id), by_id.get(r.child_entity_id)
        if p and ch:
            spec["relationships"].append(
                {
                    "parent": p.physical_name,
                    "child": ch.physical_name,
                    "parent_column": next((c.physical_name for c in p.columns if c.id == r.parent_column_id), ""),
                    "child_column": next((c.physical_name for c in ch.columns if c.id == r.child_column_id), ""),
                    "cardinality": "one_to_many",
                }
            )
    return bool(ents)


def parse_markdown_tables(text: str, spec: Dict[str, Any]) -> bool:
    found = False
    blocks = re.split(r"\n(?=#{1,6}\s)", "\n" + text)
    for blk in blocks:
        head = re.match(r"\s*#{1,6}\s*(?:table\s*[:\-]?\s*)?`?([\w ]+?)`?\s*\n", blk, re.I)
        rows = [r for r in blk.splitlines() if r.strip().startswith("|")]
        if not head or len(rows) < 3:
            continue
        hdr = [h.strip().lower() for h in rows[0].strip("|").split("|")]
        if not any(h in ("column", "name", "field", "attribute", "column name") for h in hdr):
            continue
        found = True
        t = _table(spec, head.group(1))
        idx = {k: i for i, k in enumerate(hdr)}
        ni = next((idx[k] for k in ("column", "column name", "name", "field", "attribute") if k in idx), 0)
        ti = next((idx[k] for k in ("type", "data type", "datatype") if k in idx), None)
        di = next((idx[k] for k in ("description", "definition", "notes") if k in idx), None)
        ki = next((idx[k] for k in ("key", "pk", "keys", "constraints") if k in idx), None)
        for r in rows[2:]:
            cells = [c.strip() for c in r.strip().strip("|").split("|")]
            if len(cells) <= ni or not cells[ni]:
                continue
            key = cells[ki].lower() if ki is not None and ki < len(cells) else ""
            _add_col(
                t,
                cells[ni].strip("`*"),
                cells[ti] if ti is not None and ti < len(cells) else None,
                pk="pk" in key or "primary" in key,
                nullable="pk" not in key,
                description=cells[di] if di is not None and di < len(cells) else "",
            )
    return found


_ENTITY_PAT = r"([A-Za-z][A-Za-z ]{1,40}?)"
_TAIL_PAT = (
    r"([A-Za-z][A-Za-z ]{1,40}?)(?=\s*(?:[.,;:!?]|$|\s(?:and|or|but|which|that|who|with|for|in|on|at|"
    r"from|to|via|through|when|where)\b))"
)


def _noun(phrase: str) -> Optional[str]:
    words = [w for w in re.findall(r"[A-Za-z]+", phrase) if w.lower() not in STOP]
    if not words or len(words) > 3:
        return None
    return snake(singular("_".join(words[-2:]) if len(words) > 1 else words[0]))


def _attr_list(s: str) -> List[str]:
    s = re.sub(r"\(.*?\)", "", s)
    items = re.split(r",|;|\band\b|\bas well as\b|/", s)
    out = []
    for it in items:
        words = [w for w in re.findall(r"[A-Za-z0-9]+", it) if w.lower() not in STOP]
        if 0 < len(words) <= 4:
            out.append("_".join(words))
    return out


def parse_prose(text: str, spec: Dict[str, Any]) -> bool:
    """Heuristic entity/attribute/relationship extraction from notes, transcripts and briefs."""
    found = False
    clean = re.sub(r"^\s*(\[?\d{1,2}:\d{2}(:\d{2})?\]?|[A-Z][\w ]{0,20}:)\s*", "", text, flags=re.M)
    clean = re.sub(r"(?<![.!?:])\n(?=[a-z])", " ", clean)
    sentences = re.split(r"(?<=[.!?\n])\s+", clean)
    rel_pats = [
        (
            rf"\b(?:(?:each|every|a|an|one)\s+)?{_ENTITY_PAT}\s+(?:can\s+)?(?:has|have|own|owns|place|places|contain|contains|"
            rf"includes?|makes?|creates?|holds?|submits?|writes?|manages?|employs?)\s+(?:one\s+or\s+more|many|multiple|"
            rf"several|zero\s+or\s+more|any\s+number\s+of)\s+{_TAIL_PAT}",
            "1n",
        ),
        (
            rf"\b(?:each|every|a|an)\s+{_ENTITY_PAT}\s+(?:belongs\s+to|is\s+(?:placed|owned|made|created|assigned)\s+"
            rf"(?:by|to)|is\s+for|references?|is\s+linked\s+to)\s+(?:one|a|an|exactly\s+one|the|a\s+single)\s+"
            rf"{_TAIL_PAT}",
            "n1",
        ),
        (rf"\b(?:each|every|a|an)\s+{_ENTITY_PAT}\s+has\s+(?:one|a\s+single|exactly\s+one)\s+{_TAIL_PAT}", "11"),
    ]
    attr_pat = re.compile(
        rf"\b(?:(?:each|every|a|an|the)\s+)?{_ENTITY_PAT}\s+(?:has|have|records?|stores?|captures?|"
        rf"needs?|includes?|tracks?|contains?)\s+(?:an?\s+|the\s+|their\s+|its\s+)?(?:attributes?\s+|"
        rf"fields?\s+|columns?\s+|details?\s+|properties\s+)?(?:like|such as|including|:)?\s*(.+)",
        re.I,
    )
    for s in sentences:
        s = s.strip().rstrip(".")
        if not s:
            continue
        matched_rel = False
        for pat, kind in rel_pats:
            m = re.search(pat, s, re.I)
            if not m:
                continue
            a, b = _noun(m.group(1)), _noun(m.group(2))
            if not a or not b or a == b:
                continue
            found = matched_rel = True
            _table(spec, a)
            _table(spec, b)
            parent, child = (a, b) if kind in ("1n", "11") else (b, a)
            spec["relationships"].append(
                {"parent": parent, "child": child, "cardinality": "one_to_one" if kind == "11" else "one_to_many"}
            )
            break
        if matched_rel:
            continue
        m = attr_pat.search(s)
        if m:
            ent = _noun(m.group(1))
            attrs = _attr_list(m.group(2))
            if ent and len(attrs) >= 1 and not re.search(r"\b(many|multiple|several|more)\b", m.group(2), re.I):
                found = True
                t = _table(spec, ent)
                for a in attrs:
                    _add_col(t, a)
    tm = re.findall(r"\b(?:tables?|entities|entity)\s*(?:are|is|:|include|including)\s*([^.\n]+)", clean, re.I)
    for grp in tm:
        for nm in _attr_list(grp):
            found = True
            _table(spec, singular(nm))
    return found


def finalize(spec: Dict[str, Any], subject_area: str = "Core") -> Dict[str, Any]:
    """Ensure every table has a PK and every relationship resolves to concrete FK columns."""
    by_name = {t["name"]: t for t in spec["tables"]}
    for t in spec["tables"]:
        t.setdefault("subject_area", subject_area)
        t.setdefault("logical_name", humanize(t["name"]))
        if not any(c.get("pk") for c in t["columns"]):
            base = re.sub(r"^(DIM|FCT|FACT|STG|TBL)_", "", t["name"])
            pk_name = f"{base}_ID"
            existing = next((c for c in t["columns"] if c["name"] in (pk_name, "ID")), None)
            if existing:
                existing.update(pk=True, nullable=False)
            else:
                t["columns"].insert(
                    0,
                    {
                        "name": pk_name,
                        "type": "BIGINT",
                        "pk": True,
                        "nullable": False,
                        "description": f"Surrogate key of {humanize(base).lower()}.",
                    },
                )
    seen = set()
    rels = []
    for r in spec["relationships"]:
        p, c = by_name.get(snake(r["parent"])), by_name.get(snake(r["child"]))
        if not p or not c:
            continue
        ppk = next((x for x in p["columns"] if x["name"] == snake(r.get("parent_column") or "")), None) or next(
            x for x in p["columns"] if x.get("pk")
        )
        ccol_name = snake(r.get("child_column") or "") or ppk["name"]
        child_pks = [x["name"] for x in c["columns"] if x.get("pk")]
        if not r.get("child_column") and (ccol_name == "ID" or child_pks == [ccol_name]):
            ccol_name = f"{re.sub(r'^(DIM|FCT|FACT|STG|TBL)_', '', p['name'])}_{ppk['name']}".replace("_ID_ID", "_ID")
        if ccol_name == ppk["name"] and p is c:
            continue
        ccol = next((x for x in c["columns"] if x["name"] == ccol_name), None)
        if not ccol:
            ccol = {
                "name": ccol_name,
                "type": ppk["type"],
                "pk": False,
                "nullable": False,
                "description": f"Reference to {p['logical_name'].lower()}.",
            }
            c["columns"].append(ccol)
        ccol["fk"] = True
        key = (p["name"], ppk["name"], c["name"], ccol["name"])
        if key in seen:
            continue
        seen.add(key)
        rels.append(
            {
                "name": r.get("name") or f"FK_{c['name']}_{p['name']}",
                "parent": p["name"],
                "parent_column": ppk["name"],
                "child": c["name"],
                "child_column": ccol["name"],
                "cardinality": r.get("cardinality") or "one_to_many",
                "description": r.get("description", ""),
            }
        )
    spec["relationships"] = rels
    return spec


def extract_spec(text: str, subject_area: str = "Core") -> Dict[str, Any]:
    spec: Dict[str, Any] = {"tables": [], "relationships": []}
    used = []
    for name, fn in (
        ("sql", parse_sql),
        ("dbml", parse_dbml),
        ("mermaid", parse_mermaid),
        ("markdown", parse_markdown_tables),
    ):
        if fn(text, spec):
            used.append(name)
    if parse_prose(text, spec):
        used.append("prose")
    spec = finalize(spec, subject_area)
    spec["detected_formats"] = used
    return spec
