import json
import os
import sqlite3

import pytest

from backend.app.ai import editor_dsl, generator, search
from backend.app.ai import providers as prov
from backend.app.ai.documenter import apply_documentation, explain, propose_documentation
from backend.app.ai.privacy import ai_catalog, scrub_row_data
from backend.app.ai.textmodel import extract_spec
from backend.app.compilers.sqlite import compile_sqlite_ddl
from backend.app.metamodel.schema import ColumnProfileStats, ProjectMetamodel
from backend.app.metamodel.seed import build_default_project

NOTES = """Kick-off notes. We need to track customers and their orders. Each customer has a name, email and phone
number. A customer places many orders. Each order has an order date, status and total amount.
An order contains many order lines. Each order line has a quantity and unit price.
Each order line belongs to one product. Products have a name, sku and list price."""


def _model() -> ProjectMetamodel:
    return build_default_project()


def test_prose_extraction_builds_tables_keys_and_fks():
    spec = extract_spec(NOTES)
    names = {t["name"] for t in spec["tables"]}
    assert {"CUSTOMER", "ORDER", "ORDER_LINE", "PRODUCT"} <= names
    rels = {(r["parent"], r["child"], r["child_column"]) for r in spec["relationships"]}
    assert ("CUSTOMER", "ORDER", "CUSTOMER_ID") in rels
    assert ("ORDER", "ORDER_LINE", "ORDER_ID") in rels
    cust = next(t for t in spec["tables"] if t["name"] == "CUSTOMER")
    types = {c["name"]: c["type"] for c in cust["columns"]}
    assert types["EMAIL"] == "VARCHAR(320)" and types["PHONE_NUMBER"] == "VARCHAR(30)"


def test_dbml_and_mermaid_extraction():
    dbml = (
        "Table users {\n id int [pk]\n email varchar(320) [not null, unique]\n}\n"
        "Table posts {\n id int [pk]\n user_id int [ref: > users.id]\n}"
    )
    s = extract_spec(dbml)
    assert s["relationships"][0]["parent"] == "USERS" and s["relationships"][0]["child_column"] == "USER_ID"
    mer = (
        "erDiagram\n CUSTOMER ||--o{ ORDERS : places\n CUSTOMER {\n int id PK\n string name\n }\n"
        " ORDERS {\n int id PK\n }"
    )
    s = extract_spec(mer)
    assert s["relationships"][0]["child_column"] == "CUSTOMER_ID"


def test_generate_and_apply_spec_offline_merges_into_model():
    m = ProjectMetamodel(name="t")
    spec = generator.generate_spec(prov.get_provider("builtin"), NOTES, m)
    log = generator.apply_spec(m, spec)
    assert len(m.entities) == 4 and len(m.relationships) == 3 and log
    again = generator.apply_spec(m, spec)
    assert len(m.entities) == 4 and len(m.relationships) == 3 and not [x for x in again if "Added" in x]


class FakeLLM(prov.Provider):
    def __init__(self, reply):
        super().__init__(name="kiro")
        self.reply = reply
        self.prompts = []

    def _complete(self, prompt, system, images):
        self.prompts.append(prompt)
        return self.reply


def test_llm_generation_receives_metadata_only_and_parses_json():
    m = _model()
    ent = next(e for e in m.entities.values() if e.columns)
    ent.columns[0].profile = ColumnProfileStats(sample_values=["SECRET_ROW_VALUE"], min_value="SECRET_MIN")
    reply = json.dumps(
        {
            "summary": "ok",
            "tables": [
                {
                    "name": "supplier",
                    "columns": [
                        {"name": "supplier_id", "type": "BIGINT", "pk": True},
                        {"name": "name", "type": "VARCHAR(100)"},
                    ],
                }
            ],
            "relationships": [],
        }
    )
    llm = FakeLLM("```json\n" + reply + "\n```")
    spec = generator.generate_spec(llm, "we buy from suppliers", m)
    assert spec["tables"][0]["name"] == "SUPPLIER"
    assert "SECRET_ROW_VALUE" not in llm.prompts[0] and "SECRET_MIN" not in llm.prompts[0]


def test_llm_failure_falls_back_to_offline():
    class Broken(prov.Provider):
        def _complete(self, prompt, system, images):
            raise prov.LLMError("boom")

    spec = generator.generate_spec(Broken(name="devin"), NOTES, ProjectMetamodel(name="t"))
    assert spec["tables"] and spec["warnings"]


def test_privacy_catalog_and_scrub():
    m = _model()
    col = next(e for e in m.entities.values() if e.columns).columns[0]
    col.profile = ColumnProfileStats(sample_values=["a"], min_value="1", max_value="9", detected_pattern="ENUM(a|b)")
    assert "sample" not in json.dumps(ai_catalog(m))
    assert scrub_row_data(m) >= 1
    assert col.profile.sample_values == [] and col.profile.min_value is None and col.profile.detected_pattern == "ENUM"


def test_offline_search_finds_email_and_pii():
    m = _model()
    r = search.offline_search(m, "where do we store customer email?")
    assert r["results"][0]["title"] == "DIM_CUSTOMER.CUST_EMAIL_ADDR"
    pii = search.offline_search(m, "show PII columns")
    assert pii["results"] and all(x["kind"] == "column" for x in pii["results"])


def test_documentation_proposals_and_apply():
    m = _model()
    out = propose_documentation(m, only_missing=False)
    kinds = {p["target"] for p in out["proposals"]}
    assert kinds == {"entity", "column", "relationship"}
    n = apply_documentation(m, out["proposals"])
    assert n == len(out["proposals"])
    rel = next(iter(m.relationships.values()))
    assert rel.description
    ent = next(iter(m.entities.values()))
    assert ent.physical_name in explain(m, entity_id=ent.id)["markdown"]


def test_editor_round_trip_is_lossless_and_edits_apply():
    m = _model()
    text = editor_dsl.render(m)
    same = editor_dsl.apply(m, text)
    assert same["ok"] and same["changes"] == []
    assert len(same["project"].relationships) == len(m.relationships)
    tbl = next(e for e in m.entities.values() if e.entity_type == "table")
    edited = (
        text + "\nTable SALES.SUPPLIER {\n  SUPPLIER_ID BIGINT [pk]\n  NAME VARCHAR(100) [not null]\n}\n"
        f"Ref: SUPPLIER.SUPPLIER_ID < {tbl.physical_name}.{tbl.columns[0].physical_name} [0:N]\n"
    )
    out = editor_dsl.apply(m, edited)
    assert out["ok"], out["errors"]
    assert "Added table SUPPLIER" in out["changes"]
    new = out["project"]
    sup = next(e for e in new.entities.values() if e.physical_name == "SUPPLIER")
    assert sup.database_schema == "SALES" and sup.columns[0].is_pk
    assert tbl.id in new.entities and new.entities[tbl.id].position == tbl.position


def test_editor_reports_errors_with_line_numbers():
    out = editor_dsl.apply(_model(), "Table X {\n  ??? nonsense [\n")
    assert not out["ok"] and out["errors"][0]["line"] == 2


def test_sqlite_ddl_executes():
    ddl = compile_sqlite_ddl(_model())
    con = sqlite3.connect(":memory:")
    con.executescript(ddl)
    assert con.execute("select count(*) from sqlite_master where type='table'").fetchone()[0] > 3


def test_cli_providers_registered_and_missing_binary_is_clear(monkeypatch):
    for name in ("kiro", "gemini_cli", "devin"):
        assert name in prov.PROVIDERS
    monkeypatch.setattr(prov.shutil, "which", lambda _: None)
    for name in ("kiro", "gemini_cli", "devin"):
        with pytest.raises(prov.LLMError):
            prov.get_provider(name, {"command": "definitely-missing-cli"}).complete("hi")


def test_extract_json_handles_fences_and_ansi():
    assert prov.extract_json('\x1b[32mHere:\x1b[0m ```json\n{"a": 1}\n```') == {"a": 1}
    assert prov.extract_json("noise [1, 2] tail") == [1, 2]


def test_ai_api_endpoints():
    from fastapi.testclient import TestClient

    from backend.app.main import app

    c = TestClient(app)
    tok = c.post(
        "/api/auth/login",
        json={
            "email": os.getenv("T_EMAIL", "architect@metaforge.local"),
            "password": os.getenv("T_PASS", "password123"),
        },
    )
    if tok.status_code != 200:
        pytest.skip("seed admin login unavailable")
    h = {"Authorization": f"Bearer {tok.json()['access_token']}"}
    p = c.get("/api/ai/providers", headers=h).json()
    assert {"kiro", "gemini_cli", "devin", "builtin"} <= {x["name"] for x in p["providers"]}
    proj = _model().model_dump()
    g = c.post(
        "/api/ai/generate",
        headers=h,
        json={"project": proj, "text": NOTES, "use_library": False, "provider": "builtin"},
    ).json()
    assert g["diff"]["new_tables"]
    a = c.post("/api/ai/generate/apply", headers=h, json={"project": proj, "spec": g["spec"]}).json()
    assert len(a["project"]["entities"]) > len(proj["entities"])
    s = c.post("/api/ai/search", headers=h, json={"project": proj, "query": "customer email"}).json()
    assert s["results"]
    r = c.post("/api/ai/editor/render", headers=h, json={"project": proj}).json()
    e = c.post("/api/ai/editor/apply", headers=h, json={"project": proj, "text": r["text"]}).json()
    assert e["ok"] and e["changes"] == []
    comp = c.post("/api/project/compile", headers=h, json={"project": proj}).json()
    assert "CREATE TABLE IF NOT EXISTS" in comp["sqlite_ddl"]


def test_metadata_only_blocks_live_profiling_and_row_counts():
    from fastapi.testclient import TestClient

    from backend.app.main import app

    c = TestClient(app)
    tok = c.post("/api/auth/login", json={"email": "architect@metaforge.local", "password": "password123"})
    h = {"Authorization": f"Bearer {tok.json()['access_token']}"}
    conns = c.get("/api/connections", headers=h).json()
    if not conns:
        pytest.skip("no demo connection")
    cid = conns[0]["id"]
    r = c.post(f"/api/connections/{cid}/profile", headers=h, json={})
    assert r.status_code == 403 and "Metadata-only" in r.json()["detail"]
    priv = c.get("/api/ai/privacy", headers=h).json()
    assert priv["settings"]["metadata_only"] is True


def _fake_cli(tmp_path, name, body):
    exe = tmp_path / name
    exe.write_text("#!/bin/sh\n" + body)
    exe.chmod(0o755)
    return exe


def test_cli_providers_execute_headless_subprocess(tmp_path, monkeypatch):
    reply = '{"answer": "ok", "matches": []}'
    _fake_cli(tmp_path, "gemini", f"cat > /dev/null; printf '\\033[32m%s\\033[0m' '{reply}'\n")
    _fake_cli(tmp_path, "kiro-cli", f"printf '%s' '{reply}'\n")
    _fake_cli(tmp_path, "devin", 'if [ "$1" = auth ]; then echo "Logged in"; exit 0; fi\n'
                                 f"printf '%s' '{reply}'\n")
    monkeypatch.setenv("PATH", f"{tmp_path}:{os.environ['PATH']}")
    prov._DEVIN_AUTH_OK.clear()
    for name in ("gemini_cli", "kiro", "devin"):
        assert prov.get_provider(name).complete_json("q") == {"answer": "ok", "matches": []}, name
    assert prov.detect_available()["devin"] is True


def test_devin_cli_not_logged_in_is_reported(tmp_path, monkeypatch):
    _fake_cli(tmp_path, "devin", 'echo "Not logged in"; exit 1\n')
    monkeypatch.setenv("PATH", f"{tmp_path}:{os.environ['PATH']}")
    prov._DEVIN_AUTH_OK.clear()
    with pytest.raises(prov.LLMError, match="not logged in"):
        prov.get_provider("devin").complete("hi")


def test_singular_handles_common_plurals():
    from backend.app.ai.textmodel import singular

    cases = {"purchases": "purchase", "addresses": "address", "boxes": "box", "categories": "category",
             "statuses": "status", "orders": "order", "class": "class"}
    for plural, single in cases.items():
        assert singular(plural) == single, plural
