"""Excel (.xlsx) and CSV (.csv) File Ingestion, Profiling, and Reverse Engineering Engine.

Pure Python standard library implementation requiring zero external wheels.
Reads multi-sheet Excel workbooks and CSV files, infers types, profiles data distributions,
synthesizes canonical EntityModels with columns and auto-generated definitions, and merges
them into the MetaForge Studio project metamodel.
"""

from __future__ import annotations

import csv
import io
import re
import uuid
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field

from backend.app.metamodel.schema import (
    ColumnModel,
    ColumnProfileStats,
    EntityModel,
    EntityVolumetrics,
    ProjectMetamodel,
    RelationshipModel,
)
from backend.app.metamodel.glossary import expand_business_text, physical_to_logical_guess


class ColumnPreview(BaseModel):
    name: str
    inferred_type: str
    sample_values: List[str]
    null_count: int
    total_count: int
    null_pct: float
    distinct_count: int
    uniqueness_pct: float
    min_value: Optional[str] = None
    max_value: Optional[str] = None
    is_candidate_pk: bool = False
    inferred_domain: Optional[str] = None


class SheetInspectionResult(BaseModel):
    sheet_name: str
    table_name: str
    row_count: int
    column_count: int
    columns: List[ColumnPreview]
    sample_rows: List[Dict[str, Any]] = Field(default_factory=list)


class FileInspectionSummary(BaseModel):
    filename: str
    file_type: str  # "excel" | "csv"
    sheets: List[SheetInspectionResult]
    total_sheets: int
    total_rows: int


# ---------------------------------------------------------------------------
# Data Type and Profiling Inferrer
# ---------------------------------------------------------------------------
DATE_PATTERNS = [
    re.compile(r"^\d{4}-\d{2}-\d{2}$"),
    re.compile(r"^\d{2}/\d{2}/\d{4}$"),
    re.compile(r"^\d{2}-\d{2}-\d{4}$"),
]
TIMESTAMP_PATTERNS = [
    re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}"),
    re.compile(r"^\d{2}/\d{2}/\d{4} \d{2}:\d{2}"),
]


def infer_value_type(val: str) -> str:
    """Classifies a non-empty string value into a SQL-friendly data type."""
    v = val.strip()
    if not v:
        return "UNKNOWN"

    upper = v.upper()
    if upper in ("TRUE", "FALSE", "YES", "NO", "T", "F", "Y", "N"):
        return "BOOLEAN"

    if re.match(r"^-?\d+$", v):
        return "INTEGER"

    if re.match(r"^-?\d+\.\d+$", v):
        return "DECIMAL(18,4)"

    for p in TIMESTAMP_PATTERNS:
        if p.match(v):
            return "TIMESTAMP"

    for p in DATE_PATTERNS:
        if p.match(v):
            return "DATE"

    return "VARCHAR(255)"


def profile_column_values(
    col_name: str, values: List[Optional[str]]
) -> ColumnPreview:
    """Computes distribution statistics, uniqueness, null rate, and inferred SQL dialect type."""
    total = len(values)
    non_null_vals = [str(v).strip() for v in values if v is not None and str(v).strip() != ""]
    null_count = total - len(non_null_vals)
    null_pct = round((null_count / total * 100.0), 2) if total > 0 else 0.0

    distinct_set = set(non_null_vals)
    distinct_count = len(distinct_set)
    uniqueness_pct = (
        round((distinct_count / len(non_null_vals) * 100.0), 2)
        if non_null_vals
        else 0.0
    )

    # Inferred Type vote
    type_votes: Dict[str, int] = {}
    for v in non_null_vals[:200]:
        t = infer_value_type(v)
        type_votes[t] = type_votes.get(t, 0) + 1

    if not type_votes:
        inferred_type = "VARCHAR(255)"
    elif "VARCHAR(255)" in type_votes:
        inferred_type = "VARCHAR(255)"
    elif "DECIMAL(18,4)" in type_votes:
        inferred_type = "DECIMAL(18,4)"
    elif "INTEGER" in type_votes:
        inferred_type = "INTEGER"
    elif "TIMESTAMP" in type_votes:
        inferred_type = "TIMESTAMP"
    elif "DATE" in type_votes:
        inferred_type = "DATE"
    elif "BOOLEAN" in type_votes:
        inferred_type = "BOOLEAN"
    else:
        inferred_type = "VARCHAR(255)"

    min_val: Optional[str] = None
    max_val: Optional[str] = None
    if non_null_vals:
        try:
            sorted_vals = sorted(non_null_vals)
            min_val = sorted_vals[0]
            max_val = sorted_vals[-1]
        except Exception:
            min_val = str(non_null_vals[0])
            max_val = str(non_null_vals[-1])

    samples = list(distinct_set)[:5]
    upper_name = col_name.upper()

    # Candidate PK detection
    is_candidate_pk = (
        null_count == 0
        and uniqueness_pct == 100.0
        and (
            upper_name.endswith(("_ID", "_KEY", "_PK", "_CODE", "_SKU"))
            or upper_name in ("ID", "CODE", "KEY", "SKU")
        )
    )

    # Inferred Domain
    domain_guess = None
    if upper_name.endswith(("_AMT", "_PRICE", "_COST", "_REVENUE", "_SPEND")):
        domain_guess = "Monetary_Amount"
    elif upper_name.endswith(("_DT", "_DATE")):
        domain_guess = "Calendar_Date"
    elif upper_name.endswith(("_TS", "_TIMESTAMP", "_TIME")):
        domain_guess = "Audit_Timestamp"
    elif upper_name.endswith(("_CD", "_CODE", "_STAT", "_STATUS")):
        domain_guess = "Enterprise_Status_Code"
    elif is_candidate_pk:
        domain_guess = "Surrogate_Key"

    return ColumnPreview(
        name=col_name,
        inferred_type=inferred_type,
        sample_values=samples,
        null_count=null_count,
        total_count=total,
        null_pct=null_pct,
        distinct_count=distinct_count,
        uniqueness_pct=uniqueness_pct,
        min_value=min_val,
        max_value=max_val,
        is_candidate_pk=is_candidate_pk,
        inferred_domain=domain_guess,
    )


# ---------------------------------------------------------------------------
# CSV File Parser
# ---------------------------------------------------------------------------
def parse_csv_bytes(file_bytes: bytes, filename: str) -> FileInspectionSummary:
    """Parses a CSV byte stream, detects delimiter and headers, profiles columns, and returns inspection summary."""
    # Attempt UTF-8 decode, fallback to latin-1
    try:
        text = file_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = file_bytes.decode("latin-1")

    # Detect delimiter
    sample_text = text[:4096]
    delimiter = ","
    try:
        dialect = csv.Sniffer().sniff(sample_text, delimiters=[",", ";", "\t", "|"])
        delimiter = dialect.delimiter
    except Exception:
        if "\t" in sample_text and sample_text.count("\t") > sample_text.count(","):
            delimiter = "\t"
        elif ";" in sample_text and sample_text.count(";") > sample_text.count(","):
            delimiter = ";"

    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    rows = list(reader)
    if not rows:
        base_name = re.sub(r"[^A-Za-z0-9_]", "_", filename.rsplit(".", 1)[0]).upper()
        return FileInspectionSummary(
            filename=filename,
            file_type="csv",
            sheets=[
                SheetInspectionResult(
                    sheet_name=base_name,
                    table_name=base_name,
                    row_count=0,
                    column_count=0,
                    columns=[],
                    sample_rows=[],
                )
            ],
            total_sheets=1,
            total_rows=0,
        )

    raw_headers = [h.strip() for h in rows[0]]
    clean_headers: List[str] = []
    seen: Dict[str, int] = {}
    for idx, h in enumerate(raw_headers):
        clean = re.sub(r"[^A-Za-z0-9_]", "_", h.strip()) or f"COL_{idx + 1}"
        clean_upper = clean.upper()
        if clean_upper in seen:
            seen[clean_upper] += 1
            clean_headers.append(f"{clean_upper}_{seen[clean_upper]}")
        else:
            seen[clean_upper] = 1
            clean_headers.append(clean_upper)

    data_rows = rows[1:]
    col_data: Dict[str, List[Optional[str]]] = {h: [] for h in clean_headers}

    for r in data_rows:
        for idx, h in enumerate(clean_headers):
            val = r[idx].strip() if idx < len(r) else None
            col_data[h].append(val)

    columns: List[ColumnPreview] = []
    for h in clean_headers:
        columns.append(profile_column_values(h, col_data[h]))

    # Sample rows formatted as dicts
    sample_rows: List[Dict[str, Any]] = []
    for r in data_rows[:5]:
        row_dict = {}
        for idx, h in enumerate(clean_headers):
            row_dict[h] = r[idx] if idx < len(r) else ""
        sample_rows.append(row_dict)

    base_name = re.sub(r"[^A-Za-z0-9_]", "_", filename.rsplit(".", 1)[0]).upper()
    if not base_name.startswith(("STG_", "RAW_", "SRC_")):
        table_name = f"STG_{base_name}"
    else:
        table_name = base_name

    sheet_res = SheetInspectionResult(
        sheet_name=base_name,
        table_name=table_name,
        row_count=len(data_rows),
        column_count=len(clean_headers),
        columns=columns,
        sample_rows=sample_rows,
    )

    return FileInspectionSummary(
        filename=filename,
        file_type="csv",
        sheets=[sheet_res],
        total_sheets=1,
        total_rows=len(data_rows),
    )


# ---------------------------------------------------------------------------
# Excel (.xlsx) File Parser (Pure Stdlib zipfile + XML)
# ---------------------------------------------------------------------------
def _col_idx_from_cell_ref(ref: str) -> int:
    """Converts a cell reference like 'B2' or 'AA5' to a 0-based column index."""
    match = re.match(r"^([A-Z]+)", ref)
    if not match:
        return 0
    letters = match.group(1)
    idx = 0
    for ch in letters:
        idx = idx * 26 + (ord(ch) - ord("A") + 1)
    return idx - 1


def parse_excel_bytes(file_bytes: bytes, filename: str) -> FileInspectionSummary:
    """Parses an Excel (.xlsx) workbook using zipfile and xml.etree.ElementTree without external libraries."""
    buf = io.BytesIO(file_bytes)
    with zipfile.ZipFile(buf, "r") as zf:
        namelist = zf.namelist()

        # 1. Parse Shared Strings table if present
        shared_strings: List[str] = []
        if "xl/sharedStrings.xml" in namelist:
            sst_root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
            for si in sst_root.findall(".//s:si", ns):
                # May contain <t> directly or runs of <r><t>
                text_parts = [t.text or "" for t in si.findall(".//s:t", ns)]
                shared_strings.append("".join(text_parts))

        # 2. Parse Workbook to get sheet list & r:id mapping
        wb_root = ET.fromstring(zf.read("xl/workbook.xml"))
        ns_wb = {
            "s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
            "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        }
        sheet_names: List[Tuple[str, str]] = []  # (name, rId)
        for s in wb_root.findall(".//s:sheet", ns_wb):
            s_name = s.attrib.get("name", "Sheet")
            r_id = (
                s.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
                or s.attrib.get("r:id", "")
            )
            sheet_names.append((s_name, r_id))

        # Map rId -> target sheet file path via xl/_rels/workbook.xml.rels
        rel_map: Dict[str, str] = {}
        if "xl/_rels/workbook.xml.rels" in namelist:
            rels_root = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
            for rel in rels_root:
                rid = rel.attrib.get("Id")
                tgt = rel.attrib.get("Target")
                if rid and tgt:
                    if not tgt.startswith("xl/"):
                        tgt = f"xl/{tgt.lstrip('/')}"
                    rel_map[rid] = tgt

        sheets_result: List[SheetInspectionResult] = []
        total_rows = 0

        # 3. Parse Each Worksheet
        for s_idx, (s_name, r_id) in enumerate(sheet_names):
            sheet_path = rel_map.get(r_id, f"xl/worksheets/sheet{s_idx + 1}.xml")
            if sheet_path not in namelist:
                continue

            ws_root = ET.fromstring(zf.read(sheet_path))
            ns_ws = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}

            rows_data: List[List[str]] = []
            max_cols = 0

            for row_elem in ws_root.findall(".//s:row", ns_ws):
                row_vals: Dict[int, str] = {}
                for c in row_elem.findall("s:c", ns_ws):
                    c_ref = c.attrib.get("r", "")
                    col_idx = _col_idx_from_cell_ref(c_ref)
                    c_type = c.attrib.get("t", "")

                    v_elem = c.find("s:v", ns_ws)
                    val = ""
                    if c_type == "s" and v_elem is not None and v_elem.text:
                        # Shared string index
                        try:
                            s_idx_val = int(v_elem.text)
                            if 0 <= s_idx_val < len(shared_strings):
                                val = shared_strings[s_idx_val]
                        except ValueError:
                            val = v_elem.text or ""
                    elif c_type == "inlineStr":
                        t_elem = c.find(".//s:t", ns_ws)
                        val = t_elem.text if t_elem is not None and t_elem.text else ""
                    elif v_elem is not None and v_elem.text:
                        val = v_elem.text.strip()

                    row_vals[col_idx] = val
                    if col_idx + 1 > max_cols:
                        max_cols = col_idx + 1

                # Construct array with empty placeholders for missing cells
                row_arr = [row_vals.get(i, "") for i in range(max_cols)]
                if any(row_arr):
                    rows_data.append(row_arr)

            if not rows_data:
                continue

            # Headers = first row
            raw_headers = rows_data[0]
            clean_headers: List[str] = []
            seen: Dict[str, int] = {}
            for i, h in enumerate(raw_headers):
                c = re.sub(r"[^A-Za-z0-9_]", "_", str(h).strip()) or f"COL_{i + 1}"
                c_up = c.upper()
                if c_up in seen:
                    seen[c_up] += 1
                    clean_headers.append(f"{c_up}_{seen[c_up]}")
                else:
                    seen[c_up] = 1
                    clean_headers.append(c_up)

            data_rows = rows_data[1:]
            col_data: Dict[str, List[Optional[str]]] = {h: [] for h in clean_headers}

            for r in data_rows:
                for idx, h in enumerate(clean_headers):
                    val = r[idx].strip() if idx < len(r) else None
                    col_data[h].append(val)

            columns: List[ColumnPreview] = []
            for h in clean_headers:
                columns.append(profile_column_values(h, col_data[h]))

            sample_rows: List[Dict[str, Any]] = []
            for r in data_rows[:5]:
                row_dict = {}
                for idx, h in enumerate(clean_headers):
                    row_dict[h] = r[idx] if idx < len(r) else ""
                sample_rows.append(row_dict)

            clean_sheet = re.sub(r"[^A-Za-z0-9_]", "_", s_name).upper()
            if not clean_sheet.startswith(("STG_", "DIM_", "FCT_", "MART_", "RAW_")):
                table_name = f"STG_{clean_sheet}"
            else:
                table_name = clean_sheet

            sheet_res = SheetInspectionResult(
                sheet_name=s_name,
                table_name=table_name,
                row_count=len(data_rows),
                column_count=len(clean_headers),
                columns=columns,
                sample_rows=sample_rows,
            )
            sheets_result.append(sheet_res)
            total_rows += len(data_rows)

        return FileInspectionSummary(
            filename=filename,
            file_type="excel",
            sheets=sheets_result,
            total_sheets=len(sheets_result),
            total_rows=total_rows,
        )


# ---------------------------------------------------------------------------
# Metamodel Conversion & Import Logic
# ---------------------------------------------------------------------------
def _metadata_only() -> bool:
    from ..ai.settings_store import metadata_only

    return metadata_only()


def convert_sheet_to_entity(
    sheet: SheetInspectionResult,
    subject_area: str = "Staging",
    position_index: int = 0,
) -> EntityModel:
    """Converts a SheetInspectionResult into a canonical EntityModel with ColumnModels and profile statistics."""
    columns: List[ColumnModel] = []

    for col in sheet.columns:
        # Map SQL dialect types
        sf_type = col.inferred_type
        if sf_type == "INTEGER":
            sql_srv_type = "INT"
            ora_type = "NUMBER(38,0)"
            sf_type = "NUMBER(38,0)"
        elif sf_type.startswith("DECIMAL"):
            sql_srv_type = "DECIMAL(18,4)"
            ora_type = "NUMBER(18,4)"
        elif sf_type == "DATE":
            sql_srv_type = "DATE"
            ora_type = "DATE"
        elif sf_type == "TIMESTAMP":
            sql_srv_type = "DATETIME2"
            ora_type = "TIMESTAMP"
        elif sf_type == "BOOLEAN":
            sql_srv_type = "BIT"
            ora_type = "NUMBER(1)"
        else:
            sql_srv_type = "NVARCHAR(255)"
            ora_type = "VARCHAR2(255 CHAR)"

        # Infer PII
        col_up = col.name.upper()
        pii_class = "NONE"
        if any(k in col_up for k in ("EMAIL", "PHONE", "SSN", "TAX_ID", "FULL_NAME", "BIRTH", "FIRST_NAME", "LAST_NAME")):
            pii_class = "RESTRICTED_PII"
        elif any(k in col_up for k in ("AMT", "AMOUNT", "SALARY", "PRICE", "COST", "SPEND", "REVENUE")):
            pii_class = "CONFIDENTIAL"

        # Auto-synthesize rich description from profiling stats using clean business terminology
        logical_name = expand_business_text(physical_to_logical_guess(col.name))
        clean_col = expand_business_text(logical_name)
        desc_parts: List[str] = []
        if col.is_candidate_pk:
            desc_parts.append(f"Unique primary key identifier representing the {clean_col.lower()} uniquely identifying records.")
        else:
            desc_parts.append(f"Operational business attribute capturing the {clean_col.lower()}.")

        if col.null_pct == 0.0:
            desc_parts.append("Mandatory non-nullable field.")
        else:
            desc_parts.append(f"Optional field (observed null rate: {col.null_pct}%).")

        if col.sample_values and col.distinct_count <= 8 and not _metadata_only():
            samples_str = ", ".join(f"'{s}'" for s in col.sample_values[:4])
            desc_parts.append(f"Categorical domain observed with values: [{samples_str}].")
        elif col.min_value and col.max_value and col.inferred_type in ("DATE", "INTEGER", "DECIMAL(18,4)"):
            desc_parts.append(f"Observed value range: {col.min_value} to {col.max_value}.")

        profile_stats = ColumnProfileStats(
            null_pct=col.null_pct,
            distinct_count=col.distinct_count,
            uniqueness_pct=col.uniqueness_pct,
            min_value=col.min_value,
            max_value=col.max_value,
            sample_values=[] if _metadata_only() else col.sample_values,
            detected_pattern=f"FILE_IMPORTED({col.inferred_type})",
            recommended_tests=["not_null"] if col.null_pct == 0.0 else [],
            last_profiled_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        )

        columns.append(
            ColumnModel(
                logical_name=logical_name,
                physical_name=col.name,
                domain_id=None,
                data_type_snowflake=sf_type,
                data_type_sql_server=sql_srv_type,
                data_type_oracle=ora_type,
                is_pk=col.is_candidate_pk,
                is_fk=False,
                is_nullable=col.null_count > 0,
                is_unique=col.uniqueness_pct == 100.0,
                description=expand_business_text(" ".join(desc_parts)),
                metadata_status="AUTO_GENERATED",
                pii_classification=pii_class,  # type: ignore[arg-type]
                profile=profile_stats,
            )
        )

    # Grid layout arrangement
    cols_per_row = 3
    x_pos = 120 + (position_index % cols_per_row) * 420
    y_pos = 120 + (position_index // cols_per_row) * 360

    header_color = "#f59e0b" if subject_area.lower() == "staging" else "#2563eb"
    table_logical = expand_business_text(physical_to_logical_guess(sheet.table_name))

    ent = EntityModel(
        id=str(uuid.uuid4()),
        logical_name=table_logical,
        physical_name=sheet.table_name,
        database_schema="MAIN" if subject_area.lower() == "staging" else "CORE",
        subject_area=subject_area,
        description=expand_business_text(
            f"Ingested operational dataset representing {table_logical} sourced from {sheet.sheet_name}. "
            f"Contains {sheet.row_count:,} recorded rows and {len(columns)} attributes."
        ),
        metadata_status="AUTO_GENERATED",
        header_color=header_color,
        position={"x": x_pos, "y": y_pos},
        columns=columns,
        dbt_materialization="table",
        dbt_layer="staging" if subject_area.lower() == "staging" else "mart",
        tags=["file_import", "excel_csv", subject_area.lower()],
        volumetrics=EntityVolumetrics(
            estimated_row_count=sheet.row_count,
            avg_row_bytes=max(64, len(columns) * 32),
            monthly_growth_pct=5.0,
            estimated_size_gb=round((sheet.row_count * max(64, len(columns) * 32)) / (1024**3), 6),
        ),
    )
    return ent


def import_sheets_to_metamodel(
    model: ProjectMetamodel,
    sheets: List[SheetInspectionResult],
    target_subject_area: str = "Staging",
    merge_into_project: bool = True,
) -> Tuple[int, int]:
    """Imports inspected sheets into the metamodel, automatically inferring foreign key relationships between sheets."""
    if not merge_into_project:
        model.entities = {}
        model.relationships = {}

    if target_subject_area not in model.subject_areas:
        model.subject_areas.append(target_subject_area)

    start_idx = len(model.entities)
    added_entities: List[EntityModel] = []

    for i, s in enumerate(sheets):
        ent = convert_sheet_to_entity(
            sheet=s,
            subject_area=target_subject_area,
            position_index=start_idx + i,
        )
        model.entities[ent.id] = ent
        added_entities.append(ent)

    # Infer Cross-Table Foreign Key Relationships based on PK-FK matching column names
    # e.g., if Table A has candidate PK 'CUSTOMER_ID' and Table B has 'CUSTOMER_ID'
    pk_registry: Dict[str, Tuple[str, str]] = {}  # col_name -> (entity_id, column_id)
    for ent in model.entities.values():
        for col in ent.columns:
            if col.is_pk:
                pk_registry[col.physical_name.upper()] = (ent.id, col.id)

    added_rels = 0
    for ent in added_entities:
        for col in ent.columns:
            col_up = col.physical_name.upper()
            if not col.is_pk and col_up in pk_registry:
                parent_ent_id, parent_col_id = pk_registry[col_up]
                if parent_ent_id != ent.id:
                    col.is_fk = True
                    rel_id = str(uuid.uuid4())
                    model.relationships[rel_id] = RelationshipModel(
                        id=rel_id,
                        name=f"FK_{ent.physical_name}_{col.physical_name}",
                        parent_entity_id=parent_ent_id,
                        child_entity_id=ent.id,
                        parent_column_id=parent_col_id,
                        child_column_id=col.id,
                        cardinality="1:N",
                        rel_type="non_identifying",
                        transformation_note=f"Inferred join on {col.physical_name}",
                    )
                    added_rels += 1

    return len(added_entities), added_rels


# ---------------------------------------------------------------------------
# Data Dictionary Export (CSV)
# ---------------------------------------------------------------------------
def export_metamodel_to_csv_dictionary(model: ProjectMetamodel) -> str:
    """Exports all entities, columns, data types, domains, PII tags, and profiling metrics into an enterprise CSV dictionary."""
    output = io.StringIO()
    writer = csv.writer(output)

    writer.writerow(
        [
            "Subject_Area",
            "Database_Schema",
            "Table_Physical_Name",
            "Table_Logical_Name",
            "Entity_Type",
            "Modeling_Stereotype",
            "Estimated_Row_Count",
            "Table_Description",
            "Column_Physical_Name",
            "Column_Logical_Name",
            "Snowflake_Type",
            "SQL_Server_Type",
            "Oracle_Type",
            "Domain_Name",
            "Is_PK",
            "Is_FK",
            "Is_Nullable",
            "PII_Classification",
            "Metadata_Status",
            "Column_Description",
            "Profile_Null_Pct",
            "Profile_Distinct_Count",
            "Profile_Uniqueness_Pct",
            "Sample_Values",
        ]
    )

    for ent in model.entities.values():
        row_cnt = ent.volumetrics.estimated_row_count if ent.volumetrics else 0
        for col in ent.columns:
            domain_nm = (
                model.domains[col.domain_id].name
                if col.domain_id and col.domain_id in model.domains
                else ""
            )
            prof = col.profile
            null_pct = prof.null_pct if prof else ""
            dist_cnt = prof.distinct_count if prof else ""
            uniq_pct = prof.uniqueness_pct if prof else ""
            samples = ", ".join(prof.sample_values[:5]) if prof and prof.sample_values else ""

            writer.writerow(
                [
                    ent.subject_area,
                    ent.database_schema,
                    ent.physical_name,
                    ent.logical_name,
                    ent.entity_type,
                    ent.modeling_stereotype,
                    row_cnt,
                    ent.description,
                    col.physical_name,
                    col.logical_name,
                    col.data_type_snowflake,
                    col.data_type_sql_server,
                    col.data_type_oracle,
                    domain_nm,
                    "Y" if col.is_pk else "N",
                    "Y" if col.is_fk else "N",
                    "Y" if col.is_nullable else "N",
                    col.pii_classification,
                    col.metadata_status,
                    col.description,
                    null_pct,
                    dist_cnt,
                    uniq_pct,
                    samples,
                ]
            )

    return output.getvalue()
