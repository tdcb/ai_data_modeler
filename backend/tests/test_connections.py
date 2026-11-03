"""Live Database Connection tests: CRUD, test, reverse engineering, SQL profiling, and DDL execution."""
from fastapi.testclient import TestClient

from backend.app.main import app

client = TestClient(app)


def _login(email: str = "architect@metaforge.local") -> dict:
    res = client.post("/api/auth/login", json={"email": email, "password": "password123"})
    assert res.status_code == 200
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


def _demo_conn_id(headers: dict) -> int:
    conns = client.get("/api/connections", headers=headers).json()
    demo = next(c for c in conns if c["dialect"] == "sqlite" and c["is_default"])
    return demo["id"]


def test_demo_connection_seeded_and_testable():
    headers = _login()
    conn_id = _demo_conn_id(headers)
    res = client.post(
        "/api/connections/test", json={"id": conn_id, "name": "x"}, headers=headers
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert "DIM_AGENT_BROKER" in [t.upper() for t in body["tables"]]
    assert "VW_CUSTOMER_CLAIM_SUMMARY" in [v.upper() for v in body["views"]]


def test_connection_crud_and_rbac(tmp_path):
    headers = _login()
    payload = {
        "name": "Pytest Scratch SQLite",
        "dialect": "sqlite",
        "database_name": str(tmp_path / "scratch.db"),
    }
    created = client.post("/api/connections", json=payload, headers=headers)
    assert created.status_code == 200
    cid = created.json()["id"]
    assert "password_secret" not in created.json()

    # Viewer cannot create connections
    viewer = _login("viewer@metaforge.local")
    denied = client.post("/api/connections", json={**payload, "name": "nope"}, headers=viewer)
    assert denied.status_code == 403

    deleted = client.delete(f"/api/connections/{cid}", headers=headers)
    assert deleted.status_code == 200


def test_live_reverse_engineer_profile_and_ddl(tmp_path, profiling_allowed):
    headers = _login()
    conn_id = _demo_conn_id(headers)
    project = client.get("/api/project", headers=headers).json()

    # Reverse engineer only the broker table from the live DB
    rev = client.post(
        f"/api/connections/{conn_id}/reverse-engineer",
        json={
            "project": project,
            "subject_area": "Distribution",
            "selected_objects": ["DIM_AGENT_BROKER"],
            "merge_into_project": True,
        },
        headers=headers,
    )
    assert rev.status_code == 200
    body = rev.json()
    assert body["entities_parsed"] == 1
    broker = next(
        e for e in body["project"]["entities"].values() if e["physical_name"] == "DIM_AGENT_BROKER"
    )
    assert broker["volumetrics"]["estimated_row_count"] == 4

    # Full import (replace mode) must recover all 4 physical FKs + view lineage
    full = client.post(
        f"/api/connections/{conn_id}/reverse-engineer",
        json={"project": project, "subject_area": "Live", "merge_into_project": False},
        headers=headers,
    ).json()
    rel_types = [r["rel_type"] for r in full["project"]["relationships"].values()]
    assert full["entities_parsed"] >= 5
    assert sum(1 for t in rel_types if t != "upstream_lineage") >= 4
    assert "upstream_lineage" in rel_types

    # Live SQL profiling of that entity
    prof = client.post(
        f"/api/connections/{conn_id}/profile",
        json={"project": body["project"], "entity_id": broker["id"]},
        headers=headers,
    )
    assert prof.status_code == 200
    stats = prof.json()["stats"]
    assert stats["live_tables_profiled"] == 1
    prof_broker = prof.json()["project"]["entities"][broker["id"]]
    region = next(c for c in prof_broker["columns"] if c["physical_name"] == "BRKR_REGION_CD")
    assert region["profile"]["distinct_count"] == 4
    assert region["profile"]["null_pct"] == 0.0

    # DDL execution on a scratch SQLite connection (Snowflake-flavoured DDL gets adapted)
    scratch = client.post(
        "/api/connections",
        json={"name": "Pytest DDL Target", "dialect": "sqlite", "database_name": str(tmp_path / "ddl.db")},
        headers=headers,
    ).json()
    ddl = (
        "CREATE OR REPLACE MASKING POLICY CORE.PII_MASK AS (v STRING) RETURNS STRING -> v;\n"
        "CREATE OR REPLACE TABLE CORE.T_DEMO (ID NUMBER(38,0) PRIMARY KEY, NM VARCHAR(50) NOT NULL);"
    )
    dry = client.post(
        f"/api/connections/{scratch['id']}/execute-ddl",
        json={"ddl_script": ddl, "dry_run": True},
        headers=headers,
    ).json()
    assert dry["statements_skipped"] == 1 and dry["errors"] == 0

    real = client.post(
        f"/api/connections/{scratch['id']}/execute-ddl",
        json={"ddl_script": ddl, "dry_run": False},
        headers=headers,
    ).json()
    assert real["ok"] is True and real["statements_executed"] == 1

    tested = client.post(
        "/api/connections/test", json={"id": scratch["id"], "name": "x"}, headers=headers
    ).json()
    assert "T_DEMO" in [t.upper() for t in tested["tables"]]

    client.delete(f"/api/connections/{scratch['id']}", headers=headers)
    client.post("/api/project/reset", headers=headers)
