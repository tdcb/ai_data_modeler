from enum import Enum
from typing import Dict, List, Optional, Literal
from pydantic import BaseModel, Field
import uuid


class TargetDialect(str, Enum):
    SNOWFLAKE = "snowflake"
    SQL_SERVER = "sql_server"
    ORACLE = "oracle"


class Cardinality(str, Enum):
    ONE_TO_ONE = "1:1"
    ONE_TO_MANY = "1:N"
    ZERO_TO_ONE = "0:1"
    ZERO_TO_MANY = "0:N"


class RelationshipType(str, Enum):
    IDENTIFYING = "identifying"
    NON_IDENTIFYING = "non_identifying"
    UPSTREAM_LINEAGE = "upstream_lineage"


class EnterpriseDomain(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    logical_type: str
    snowflake_type: str
    sql_server_type: str
    oracle_type: str
    nullable_default: bool = True
    dbt_tests: List[str] = Field(default_factory=list)
    description: str = ""


class SnowflakePhysicalProps(BaseModel):
    transient: bool = False
    cluster_by: List[str] = Field(default_factory=list)
    data_retention_days: int = 1
    tags: Dict[str, str] = Field(default_factory=dict)


class SqlServerPhysicalProps(BaseModel):
    schema_name: str = "dbo"
    filegroup: str = "PRIMARY"
    clustered_columnstore: bool = False
    system_versioned_temporal: bool = False


class OraclePhysicalProps(BaseModel):
    schema_name: str = "CORE_DATA"
    tablespace: str = "USERS"
    index_tablespace: str = "USERS_IDX"
    partition_by_range_col: Optional[str] = None
    partition_interval: Optional[str] = "NUMTOYMINTERVAL(1, 'MONTH')"
    partition_by_list_col: Optional[str] = None
    pctfree: int = 10
    compress_for_oltp: bool = False


class DataRetentionPolicy(BaseModel):
    regulatory_framework: Literal[
        "NONE", "GDPR", "CCPA", "HIPAA", "SOX_7YR", "PCI_DSS"
    ] = "NONE"
    active_retention_days: int = 365
    archive_retention_days: int = 2555
    disposition_action: Literal[
        "KEEP_INDEFINITELY",
        "ARCHIVE_TO_COLD_STORAGE",
        "PURGE_HARD_DELETE",
        "ANONYMIZE_PII",
    ] = "ARCHIVE_TO_COLD_STORAGE"
    retention_date_column: Optional[str] = None
    legal_hold: bool = False


class DataContractSLA(BaseModel):
    data_owner: str = "Enterprise Data Architecture"
    data_steward: str = "steward@metaforge.local"
    producing_system: str = "Core Insurance / Guidewire"
    freshness_sla_hours: int = 24
    completeness_sla_pct: float = 99.5
    tier: Literal[
        "Tier-1 Mission Critical", "Tier-2 Operational", "Tier-3 Self-Service"
    ] = "Tier-1 Mission Critical"


class EntityVolumetrics(BaseModel):
    estimated_row_count: int = 100000
    avg_row_bytes: int = 256
    monthly_growth_pct: float = 5.0
    estimated_size_gb: float = 0.03


class ColumnProfileStats(BaseModel):
    null_pct: float = 0.0
    distinct_count: int = 100
    uniqueness_pct: float = 100.0
    min_value: Optional[str] = None
    max_value: Optional[str] = None
    sample_values: List[str] = Field(default_factory=list)
    detected_pattern: Optional[str] = None
    recommended_tests: List[str] = Field(default_factory=list)
    last_profiled_at: Optional[str] = None


class ColumnModel(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    logical_name: str
    physical_name: str
    domain_id: Optional[str] = None
    data_type_snowflake: str = "VARCHAR(255)"
    data_type_sql_server: str = "NVARCHAR(255)"
    data_type_oracle: str = "VARCHAR2(255 CHAR)"
    is_pk: bool = False
    is_fk: bool = False
    is_ak: bool = False
    is_nullable: bool = True
    is_unique: bool = False
    is_identity: bool = False
    default_value: Optional[str] = None
    check_constraint: Optional[str] = None
    source_expression: Optional[str] = None
    description: str = ""
    metadata_status: Literal["DRAFT", "AUTO_GENERATED", "STEWARD_VERIFIED"] = "DRAFT"
    pii_classification: Literal[
        "NONE", "INTERNAL", "CONFIDENTIAL", "RESTRICTED_PII"
    ] = "NONE"
    dbt_tests: List[str] = Field(default_factory=list)
    tags: List[str] = Field(default_factory=list)
    profile: Optional[ColumnProfileStats] = None


class EntityPosition(BaseModel):
    x: float = 100.0
    y: float = 100.0


ModelingStereotype = Literal[
    "DIM_SCD1",
    "DIM_SCD2",
    "FCT_TRANSACTION",
    "FCT_SNAPSHOT",
    "VAULT_HUB",
    "VAULT_LINK",
    "VAULT_SATELLITE",
    "ODS_STAGING",
    "ANALYTICAL_VIEW",
]


class EntityModel(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    entity_type: Literal["table", "view", "materialized_view"] = "table"
    modeling_stereotype: ModelingStereotype = "DIM_SCD1"
    logical_name: str
    physical_name: str
    grain_statement: str = ""
    database_schema: str = "CORE"
    subject_area: str = "Core"
    description: str = ""
    metadata_status: Literal["DRAFT", "AUTO_GENERATED", "STEWARD_VERIFIED"] = "DRAFT"
    header_color: str = "#2563eb"
    position: EntityPosition = Field(default_factory=EntityPosition)
    columns: List[ColumnModel] = Field(default_factory=list)
    view_sql: Optional[str] = None
    dbt_materialization: Literal["table", "view", "incremental", "ephemeral"] = "table"
    dbt_layer: Literal["source", "staging", "intermediate", "mart"] = "mart"
    dbt_unique_key: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    sample_questions: List[str] = Field(default_factory=list)
    retention_policy: DataRetentionPolicy = Field(default_factory=DataRetentionPolicy)
    data_contract: DataContractSLA = Field(default_factory=DataContractSLA)
    volumetrics: EntityVolumetrics = Field(default_factory=EntityVolumetrics)
    snowflake_props: SnowflakePhysicalProps = Field(
        default_factory=SnowflakePhysicalProps
    )
    sql_server_props: SqlServerPhysicalProps = Field(
        default_factory=SqlServerPhysicalProps
    )
    oracle_props: OraclePhysicalProps = Field(default_factory=OraclePhysicalProps)


class RelationshipModel(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    parent_entity_id: str
    child_entity_id: str
    parent_column_id: str
    child_column_id: str
    cardinality: Cardinality = Cardinality.ONE_TO_MANY
    rel_type: RelationshipType = RelationshipType.NON_IDENTIFYING
    is_mandatory: bool = True
    transformation_note: Optional[str] = None
    description: str = ""


class StickyNoteModel(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    text: str
    color: str = "#fef08a"
    subject_area: str = "Core"
    position: EntityPosition = Field(default_factory=EntityPosition)


class NamingStandardGlossary(BaseModel):
    abbreviations: Dict[str, str] = Field(default_factory=dict)


class ProjectMetamodel(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    version: str = "1.0.0"
    subject_areas: List[str] = Field(
        default_factory=lambda: ["Core", "Finance", "Claims", "Staging"]
    )
    domains: Dict[str, EnterpriseDomain] = Field(default_factory=dict)
    glossary: NamingStandardGlossary = Field(default_factory=NamingStandardGlossary)
    entities: Dict[str, EntityModel] = Field(default_factory=dict)
    relationships: Dict[str, RelationshipModel] = Field(default_factory=dict)
    annotations: Dict[str, StickyNoteModel] = Field(default_factory=dict)


class CompileResponse(BaseModel):
    snowflake_ddl: str
    sql_server_ddl: str
    oracle_ddl: str
    dbt_sources_yml: str
    dbt_schema_yml: str
    dbt_models_sql: Dict[str, str]
    datacontract_yaml: str = ""
