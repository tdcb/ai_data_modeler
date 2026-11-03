"""Tests for Multi-Zone SQLite, Excel/CSV Ingestion, Profiling Definition Generator, and Metadata Pushback."""
import io
import zipfile
import pytest
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


def test_multizone_sqlite_discovery_and_zones():
    """Verify that the SQLite demo warehouse has Staging, Core / DWH, and Consumption layers."""
    headers = _login()
    conn_id = _demo_conn_id(headers)

    res = client.post(
        "/api/connections/test", json={"id": conn_id, "name": "demo"}, headers=headers
    )
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    tables = [t.upper() for t in data["tables"]]
    views = [v.upper() for v in data["views"]]

    # Staging zone
    assert "STG_CUSTOMERS" in tables
    assert "STG_ORDERS" in tables
    assert "STG_ORDER_ITEMS" in tables
    assert "STG_PRODUCTS" in tables
    assert "STG_WEB_CLICKS" in tables

    # Core / DWH zone
    assert "DIM_CUSTOMER" in tables
    assert "DIM_PRODUCT" in tables
    assert "DIM_DATE" in tables
    assert "FCT_ORDERS" in tables
    assert "FCT_ORDER_ITEMS" in tables

    # Consumption zone
    assert "MART_CUSTOMER_LIFETIME_VALUE" in views
    assert "MART_MONTHLY_REVENUE_KPIS" in views
    assert "MART_PRODUCT_CATEGORY_PERFORMANCE" in views


def test_multizone_reverse_engineering_and_routing():
    """Verify reverse engineering routes tables to Staging, Core, and Consumption subject areas with color headers."""
    headers = _login()
    conn_id = _demo_conn_id(headers)
    project = client.get("/api/project", headers=headers).json()

    rev = client.post(
        f"/api/connections/{conn_id}/reverse-engineer",
        json={
            "project": project,
            "subject_area": "Core",
            "merge_into_project": False,
        },
        headers=headers,
    )
    assert rev.status_code == 200
    body = rev.json()
    entities = body["project"]["entities"]

    # Verify Staging entity
    stg_cust = next((e for e in entities.values() if e["physical_name"] == "STG_CUSTOMERS"), None)
    assert stg_cust is not None
    assert stg_cust["subject_area"] == "Staging"
    assert stg_cust["header_color"] == "#f59e0b"
    assert stg_cust["dbt_layer"] == "staging"

    # Verify Consumption entity
    mart_clv = next((e for e in entities.values() if e["physical_name"] == "MART_CUSTOMER_LIFETIME_VALUE"), None)
    assert mart_clv is not None
    assert mart_clv["subject_area"] == "Consumption"
    assert mart_clv["header_color"] == "#0d9488"
    assert mart_clv["dbt_layer"] == "mart"
    assert mart_clv["entity_type"] == "view"

    # Verify Core DWH entity
    dim_p = next((e for e in entities.values() if e["physical_name"] == "DIM_PRODUCT"), None)
    assert dim_p is not None
    assert dim_p["subject_area"] == "Core"
    assert dim_p["header_color"] == "#2563eb"


def test_live_sql_profiling_and_definition_generation(profiling_allowed):
    """Verify live SQL profiling updates column profiles and generates definitions based on metrics and names."""
    headers = _login()
    conn_id = _demo_conn_id(headers)

    # 1. Reverse engineer FCT_ORDERS
    project = client.get("/api/project", headers=headers).json()
    rev = client.post(
        f"/api/connections/{conn_id}/reverse-engineer",
        json={
            "project": project,
            "subject_area": "Core",
            "selected_objects": ["FCT_ORDERS"],
            "merge_into_project": True,
        },
        headers=headers,
    ).json()

    fct = next(e for e in rev["project"]["entities"].values() if e["physical_name"] == "FCT_ORDERS")

    # 2. Profile FCT_ORDERS
    prof_res = client.post(
        f"/api/connections/{conn_id}/profile",
        json={"project": rev["project"], "entity_id": fct["id"]},
        headers=headers,
    )
    assert prof_res.status_code == 200
    prof_proj = prof_res.json()["project"]
    fct_prof = prof_proj["entities"][fct["id"]]

    total_col = next(c for c in fct_prof["columns"] if c["physical_name"] == "TOTAL_ORDER_AMT")
    assert total_col["profile"] is not None
    assert total_col["profile"]["null_pct"] == 0.0

    # 3. Generate definitions from profile and names
    gen_res = client.post(
        "/api/governance/generate-definitions-from-profile",
        json={"entity_id": fct["id"], "overwrite_existing": True},
        headers=headers,
    )
    assert gen_res.status_code == 200
    gen_data = gen_res.json()
    assert gen_data["ok"] is True
    assert gen_data["entities_updated"] >= 1
    assert gen_data["columns_updated"] >= 1

    updated_fct = gen_data["project"]["entities"][fct["id"]]
    updated_col = next(c for c in updated_fct["columns"] if c["physical_name"] == "TOTAL_ORDER_AMT")
    assert "Monetary" in updated_col["description"]
    assert "Mandatory" in updated_col["description"]


def test_metadata_push_to_sqlite():
    """Verify preview and live execution of metadata pushback into SQLite _metaforge_metadata repository."""
    headers = _login()
    conn_id = _demo_conn_id(headers)

    # 1. Preview statements
    prev = client.get(f"/api/connections/{conn_id}/preview-push-metadata", headers=headers)
    assert prev.status_code == 200
    prev_data = prev.json()
    assert prev_data["dialect"] == "sqlite"
    assert prev_data["total_statements"] > 0
    assert any("INSERT OR REPLACE INTO _metaforge_metadata" in s["sql"] for s in prev_data["statements"])

    # 2. Push metadata live
    push_res = client.post(
        f"/api/connections/{conn_id}/push-metadata",
        json={"dry_run": False},
        headers=headers,
    )
    assert push_res.status_code == 200
    push_data = push_res.json()
    assert push_data["ok"] is True
    assert push_data["statements_executed"] > 0
    assert push_data["errors"] == 0


def test_csv_file_inspection_and_commit():
    """Verify uploading a CSV file inspects columns, infers types, profiles data, and commits to canvas."""
    headers = _login()
    csv_content = b"CUSTOMER_ID,CUSTOMER_NAME,ANNUAL_SPEND,IS_VIP,SIGNUP_DATE\n101,Acme Corp,14500.50,TRUE,2024-01-15\n102,Beta LLC,3200.00,FALSE,2024-02-20\n103,Gamma Inc,89000.00,TRUE,2024-03-05\n"

    # Upload and inspect
    files = {"file": ("enterprise_accounts.csv", io.BytesIO(csv_content), "text/csv")}
    insp_res = client.post("/api/reverse-engineer/file", files=files, headers=headers)
    assert insp_res.status_code == 200
    insp = insp_res.json()
    assert insp["file_type"] == "csv"
    assert len(insp["sheets"]) == 1
    sheet = insp["sheets"][0]
    assert sheet["row_count"] == 3
    assert sheet["column_count"] == 5

    cust_col = next(c for c in sheet["columns"] if c["name"] == "CUSTOMER_ID")
    assert cust_col["is_candidate_pk"] is True

    spend_col = next(c for c in sheet["columns"] if c["name"] == "ANNUAL_SPEND")
    assert "DECIMAL" in spend_col["inferred_type"]

    # Commit to metamodel
    commit_res = client.post(
        "/api/reverse-engineer/file/commit",
        json={"sheets": [sheet], "subject_area": "Spreadsheets", "merge_into_project": True},
        headers=headers,
    )
    assert commit_res.status_code == 200
    body = commit_res.json()
    assert body["ok"] is True
    assert body["entities_imported"] == 1
    new_ent = next(e for e in body["project"]["entities"].values() if e["subject_area"] == "Spreadsheets")
    assert len(new_ent["columns"]) == 5
    assert new_ent["volumetrics"]["estimated_row_count"] == 3


def test_excel_file_inspection_and_commit():
    """Verify uploading an .xlsx workbook parses multiple worksheets via pure Python standard library."""
    headers = _login()

    # Construct minimal in-memory xlsx with 2 sheets
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
        )
        zf.writestr(
            "xl/workbook.xml",
            '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Suppliers_Catalog" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>',
        )
        zf.writestr(
            "xl/sharedStrings.xml",
            '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4"><si><t>SUPPLIER_ID</t></si><si><t>SUPPLIER_NAME</t></si><si><t>Apex Supply</t></si><si><t>Pacific Goods</t></si></sst>',
        )
        zf.writestr(
            "xl/worksheets/sheet1.xml",
            '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>1</v></c><c r="B2" t="s"><v>2</v></c></row><row r="3"><c r="A3"><v>2</v></c><c r="B3" t="s"><v>3</v></c></row></sheetData></worksheet>',
        )
    buf.seek(0)

    files = {"file": ("vendor_master.xlsx", buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    res = client.post("/api/reverse-engineer/file", files=files, headers=headers)
    assert res.status_code == 200
    data = res.json()
    assert data["file_type"] == "excel"
    assert len(data["sheets"]) == 1
    sh = data["sheets"][0]
    assert sh["sheet_name"] == "Suppliers_Catalog"
    assert sh["row_count"] == 2
    assert sh["column_count"] == 2

    # Commit sheet to metamodel
    commit_res = client.post(
        "/api/reverse-engineer/file/commit",
        json={"sheets": [sh], "subject_area": "Procurement", "merge_into_project": True},
        headers=headers,
    )
    assert commit_res.status_code == 200
    assert commit_res.json()["ok"] is True
    assert commit_res.json()["entities_imported"] == 1


def test_export_data_dictionary_csv():
    """Verify exporting the entire enterprise metamodel and definitions as a CSV spreadsheet."""
    headers = _login()
    res = client.get("/api/export/data-dictionary/csv", headers=headers)
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/csv")
    csv_text = res.text
    assert "Subject_Area" in csv_text
    assert "Table_Physical_Name" in csv_text
    assert "Column_Physical_Name" in csv_text
    assert "Column_Description" in csv_text
