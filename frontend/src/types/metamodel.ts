export type TargetDialect = 'snowflake' | 'sql_server' | 'oracle';

export type ViewMode = 'logical' | 'physical' | 'conceptual';

export type Cardinality = '1:1' | '1:N' | '0:1' | '0:N';

export type RelationshipType =
  | 'identifying'
  | 'non_identifying'
  | 'upstream_lineage';

export type EntityObjectType = 'table' | 'view' | 'materialized_view';

export type ModelingStereotype =
  | 'DIM_SCD1'
  | 'DIM_SCD2'
  | 'FCT_TRANSACTION'
  | 'FCT_SNAPSHOT'
  | 'VAULT_HUB'
  | 'VAULT_LINK'
  | 'VAULT_SATELLITE'
  | 'ODS_STAGING'
  | 'ANALYTICAL_VIEW';

export type MetadataStatus = 'DRAFT' | 'AUTO_GENERATED' | 'STEWARD_VERIFIED';

export type RegulatoryFramework =
  | 'NONE'
  | 'GDPR'
  | 'CCPA'
  | 'HIPAA'
  | 'SOX_7YR'
  | 'PCI_DSS';

export type DispositionAction =
  | 'KEEP_INDEFINITELY'
  | 'ARCHIVE_TO_COLD_STORAGE'
  | 'PURGE_HARD_DELETE'
  | 'ANONYMIZE_PII';

export type PiiClassification =
  | 'NONE'
  | 'INTERNAL'
  | 'CONFIDENTIAL'
  | 'RESTRICTED_PII';

export type DbtMaterialization = 'table' | 'view' | 'incremental' | 'ephemeral';

export type DbtLayer = 'source' | 'staging' | 'intermediate' | 'mart';

export type UserRole = 'Admin' | 'Data Architect' | 'Data Steward' | 'Viewer';

export interface EnterpriseDomain {
  id: string;
  name: string;
  logical_type: string;
  snowflake_type: string;
  sql_server_type: string;
  oracle_type: string;
  nullable_default: boolean;
  dbt_tests: string[];
  description: string;
}

export interface SnowflakePhysicalProps {
  transient: boolean;
  cluster_by: string[];
  data_retention_days: number;
  tags: Record<string, string>;
}

export interface SqlServerPhysicalProps {
  schema_name: string;
  filegroup: string;
  clustered_columnstore: boolean;
  system_versioned_temporal: boolean;
}

export interface OraclePhysicalProps {
  schema_name: string;
  tablespace: string;
  index_tablespace: string;
  partition_by_range_col: string | null;
  partition_interval?: string | null;
  partition_by_list_col?: string | null;
  pctfree: number;
  compress_for_oltp: boolean;
}

export interface DataRetentionPolicy {
  regulatory_framework: RegulatoryFramework;
  active_retention_days: number;
  archive_retention_days: number;
  disposition_action: DispositionAction;
  retention_date_column?: string | null;
  legal_hold: boolean;
}

export interface DataContractSLA {
  data_owner: string;
  data_steward: string;
  producing_system: string;
  freshness_sla_hours: number;
  completeness_sla_pct: number;
  tier: 'Tier-1 Mission Critical' | 'Tier-2 Operational' | 'Tier-3 Self-Service';
}

export interface EntityVolumetrics {
  estimated_row_count: number;
  avg_row_bytes: number;
  monthly_growth_pct: number;
  estimated_size_gb: number;
}

export interface ColumnProfileStats {
  null_pct: number;
  distinct_count: number;
  uniqueness_pct: number;
  min_value?: string | null;
  max_value?: string | null;
  sample_values: string[];
  detected_pattern?: string | null;
  recommended_tests: string[];
  last_profiled_at?: string | null;
}

export interface ColumnModel {
  id: string;
  logical_name: string;
  physical_name: string;
  domain_id: string | null;
  data_type_snowflake: string;
  data_type_sql_server: string;
  data_type_oracle: string;
  is_pk: boolean;
  is_fk: boolean;
  is_ak?: boolean;
  is_nullable: boolean;
  is_unique: boolean;
  is_identity: boolean;
  default_value: string | null;
  check_constraint?: string | null;
  source_expression?: string | null;
  description: string;
  metadata_status?: MetadataStatus;
  pii_classification: PiiClassification;
  dbt_tests: string[];
  tags?: string[];
  profile?: ColumnProfileStats | null;
}

export interface EntityPosition {
  x: number;
  y: number;
}

export interface EntityModel {
  id: string;
  entity_type?: EntityObjectType;
  modeling_stereotype?: ModelingStereotype;
  logical_name: string;
  physical_name: string;
  grain_statement?: string;
  database_schema: string;
  subject_area: string;
  description: string;
  metadata_status?: MetadataStatus;
  header_color: string;
  position: EntityPosition;
  columns: ColumnModel[];
  view_sql?: string | null;
  dbt_materialization: DbtMaterialization;
  dbt_layer: DbtLayer;
  dbt_unique_key: string | null;
  tags: string[];
  sample_questions?: string[];
  retention_policy?: DataRetentionPolicy;
  data_contract?: DataContractSLA;
  volumetrics?: EntityVolumetrics;
  snowflake_props: SnowflakePhysicalProps;
  sql_server_props: SqlServerPhysicalProps;
  oracle_props: OraclePhysicalProps;
}

export interface RelationshipModel {
  id: string;
  name: string;
  parent_entity_id: string;
  child_entity_id: string;
  parent_column_id: string;
  child_column_id: string;
  cardinality: Cardinality;
  rel_type: RelationshipType;
  is_mandatory?: boolean;
  transformation_note?: string | null;
  description?: string;
}

export interface StickyNoteModel {
  id: string;
  text: string;
  color: string;
  subject_area: string;
  position: EntityPosition;
}

export interface NamingStandardGlossary {
  abbreviations: Record<string, string>;
}

export interface ProjectMetamodel {
  id: string;
  name: string;
  version: string;
  subject_areas: string[];
  domains: Record<string, EnterpriseDomain>;
  glossary: NamingStandardGlossary;
  entities: Record<string, EntityModel>;
  relationships: Record<string, RelationshipModel>;
  annotations: Record<string, StickyNoteModel>;
}

export interface UserProfile {
  id: number;
  email: string;
  full_name: string;
  role: UserRole;
  permissions: string[];
}

export interface UserDirectoryItem {
  id: number;
  email: string;
  full_name: string;
  role: UserRole;
  is_active: boolean;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  user: UserProfile;
}

export interface CompileResponse {
  snowflake_ddl: string;
  sql_server_ddl: string;
  oracle_ddl: string;
  sqlite_ddl?: string;
  dbt_files: Record<string, string>;
  datacontract_yaml?: string;
}

export interface ColumnDiffItem {
  table_name: string;
  column_name: string;
  change_type: 'ADDED' | 'DROPPED' | 'MODIFIED';
  canvas_value: string | null;
  target_value: string | null;
  details: string;
}

export interface CompareDiffResult {
  dialect: TargetDialect;
  added_tables: string[];
  dropped_tables: string[];
  modified_tables: string[];
  column_diffs: ColumnDiffItem[];
  relationship_diffs: string[];
  alter_script: string;
  total_differences: number;
}

export interface AgentExecutionResponse {
  reply: string;
  mutated: boolean;
  actions_taken: string[];
  mode_used: string;
  cli_command?: string | null;
  cli_trace?: Record<string, unknown>;
  updated_model: ProjectMetamodel;
}

export interface RevisionSummary {
  id: number;
  revision_tag: string;
  author_email: string;
  author_role: string;
  commit_message: string;
  subject_area: string;
  created_at: string;
  entity_count: number;
  relationship_count: number;
}

export interface DatabaseConnection {
  id: number;
  name: string;
  dialect: 'sqlite' | 'snowflake' | 'sql_server' | 'oracle' | 'postgresql' | string;
  host?: string | null;
  port?: number | null;
  database_name?: string | null;
  schema_name?: string | null;
  username?: string | null;
  warehouse?: string | null;
  role_name?: string | null;
  connection_url?: string | null;
  is_default: boolean;
  created_by: string;
  created_at: string;
}

export interface DatabaseTestResult {
  ok: boolean;
  latency_ms: number;
  dialect: string;
  tables: string[];
  views: string[];
  message: string;
}

export interface DdlStatementResult {
  sql: string;
  status: 'SUCCESS' | 'SKIPPED' | 'ERROR' | 'DRY_RUN_VALIDATED';
  message: string;
}

export interface DdlExecutionReport {
  ok: boolean;
  connection_name: string;
  dialect: string;
  dry_run: boolean;
  statements_executed: number;
  statements_skipped: number;
  errors: number;
  results: DdlStatementResult[];
}

export interface ColumnPreview {
  name: string;
  inferred_type: string;
  sample_values: string[];
  null_count: number;
  total_count: number;
  null_pct: number;
  distinct_count: number;
  uniqueness_pct: number;
  min_value?: string | null;
  max_value?: string | null;
  is_candidate_pk: boolean;
  inferred_domain?: string | null;
}

export interface SheetInspectionResult {
  sheet_name: string;
  table_name: string;
  row_count: number;
  column_count: number;
  columns: ColumnPreview[];
  sample_rows: Record<string, any>[];
}

export interface FileInspectionSummary {
  filename: string;
  file_type: 'excel' | 'csv';
  sheets: SheetInspectionResult[];
  total_sheets: number;
  total_rows: number;
}

export interface PushMetadataStatement {
  target: string;
  type: string;
  sql: string;
  description: string;
}

export interface PreviewPushMetadataResponse {
  connection_name: string;
  dialect: string;
  total_statements: number;
  statements: PushMetadataStatement[];
}

export interface PushMetadataReportResult {
  target: string;
  type: string;
  sql: string;
  status: 'SUCCESS' | 'ERROR' | 'DRY_RUN_VALIDATED';
  message: string;
}

export interface PushMetadataReport {
  ok: boolean;
  connection_name: string;
  dialect: string;
  dry_run: boolean;
  statements_count: number;
  statements_executed: number;
  errors: number;
  results: PushMetadataReportResult[];
}

export type RemotePermission = 'NONE' | 'VIEW' | 'EDIT' | 'ADMIN';

export type RemoteWorkMode =
  | 'view_only'
  | 'checked_out_by_me'
  | 'locked_by_other'
  | 'revoked_checkout';

export interface ModelAccessEntry {
  user_email: string;
  full_name: string;
  user_role: string;
  permission: RemotePermission;
}

export interface RevokedSessionSummary {
  checkout_id: string;
  base_version: number;
  force_released_by_email?: string | null;
  force_released_reason?: string | null;
  force_released_at?: string | null;
  has_saved_draft: boolean;
}

export interface RemoteModelSummary {
  id: string;
  name: string;
  description: string;
  current_version: number;
  version_tag: string;
  entity_count: number;
  relationship_count: number;
  created_by_email: string;
  is_locked: boolean;
  checked_out_by_email?: string | null;
  checked_out_by_name?: string | null;
  checked_out_at?: string | null;
  checkout_id?: string | null;
  updated_at: string;
  user_permission: RemotePermission;
  revoked_session?: RevokedSessionSummary | null;
}

export interface RemoteModelDetailResponse {
  summary: RemoteModelSummary;
  project: ProjectMetamodel;
  work_mode: RemoteWorkMode;
  active_checkout_id?: string | null;
  message: string;
}

export interface ReapplyMergeReport {
  applied_changes: string[];
  conflicts_skipped: string[];
  base_version: number;
  target_remote_version: number;
}

export interface CheckoutAndReapplyResponse {
  summary: RemoteModelSummary;
  project: ProjectMetamodel;
  work_mode: RemoteWorkMode;
  active_checkout_id: string;
  merge_report: ReapplyMergeReport;
  message: string;
}



