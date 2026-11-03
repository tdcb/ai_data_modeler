import { create } from 'zustand';
import type {
  Cardinality,
  CheckoutAndReapplyResponse,
  ColumnModel,
  CompileResponse,
  EnterpriseDomain,
  EntityModel,
  EntityPosition,
  ProjectMetamodel,
  ReapplyMergeReport,
  RelationshipModel,
  RelationshipType,
  RemoteModelSummary,
  RemoteWorkMode,
  StickyNoteModel,
  TargetDialect,
  UserProfile,
  ViewMode,
} from '../types/metamodel';
import { api } from '../services/api';

const INITIAL_FALLBACK_PROJECT: ProjectMetamodel = {
  id: 'proj-loading',
  name: 'Enterprise Insurance & Claims Data Warehouse',
  version: '1.3.0',
  subject_areas: ['Core', 'Finance', 'Claims', 'Staging'],
  domains: {},
  glossary: { abbreviations: {} },
  entities: {},
  relationships: {},
  annotations: {},
};

const DEFAULT_ADMIN_USER: UserProfile = {
  id: 1,
  email: 'admin@metaforge.local',
  full_name: 'Elena Vance (Enterprise Admin)',
  role: 'Admin',
  permissions: [
    'manage_users',
    'manage_settings',
    'edit_physical_model',
    'edit_business_metadata',
    'apply_glossary',
    'reverse_engineer',
    'execute_agent_mutations',
    'ask_agent_qa',
    'compile_code',
    'view_model',
  ],
};

function cloneProject(p: ProjectMetamodel): ProjectMetamodel {
  return JSON.parse(JSON.stringify(p));
}

export function translateLogicalToPhysicalLocal(
  logicalName: string,
  abbreviations: Record<string, string>
): string {
  if (!logicalName || !logicalName.trim()) return 'UNNAMED_COL';
  const spaced = logicalName.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const tokens = spaced
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toUpperCase());
  const upperMap: Record<string, string> = {};
  Object.entries(abbreviations).forEach(([k, v]) => {
    upperMap[k.toUpperCase()] = v.toUpperCase();
  });
  return tokens.map((tok) => upperMap[tok] || tok).join('_');
}

export function synthesizeViewSqlLocal(
  viewEntity: EntityModel,
  project: ProjectMetamodel
): string {
  const upstreamRels = Object.values(project.relationships).filter(
    (r) => r.child_entity_id === viewEntity.id
  );
  const upstreamEntities: EntityModel[] = [];
  for (const r of upstreamRels) {
    const p = project.entities[r.parent_entity_id];
    if (p && !upstreamEntities.some((u) => u.id === p.id)) {
      upstreamEntities.push(p);
    }
  }

  const selectItems: string[] = [];
  const groupByItems: string[] = [];
  let hasAgg = false;
  const aggPrefixes = ['SUM(', 'COUNT(', 'AVG(', 'MIN(', 'MAX(', 'LISTAGG('];

  for (const col of viewEntity.columns) {
    const expr = (col.source_expression || '').trim();
    if (expr) {
      selectItems.push(`    ${expr} AS ${col.physical_name}`);
      const upper = expr.toUpperCase();
      if (aggPrefixes.some((a) => upper.includes(a))) {
        hasAgg = true;
      } else {
        groupByItems.push(expr);
      }
    } else if (upstreamEntities.length > 0) {
      let matched = `${upstreamEntities[0].physical_name}.${col.physical_name}`;
      for (const up of upstreamEntities) {
        if (up.columns.some((c) => c.physical_name === col.physical_name)) {
          matched = `${up.physical_name}.${col.physical_name}`;
          break;
        }
      }
      selectItems.push(`    ${matched} AS ${col.physical_name}`);
      groupByItems.push(matched);
    } else {
      selectItems.push(`    ${col.physical_name}`);
    }
  }

  if (selectItems.length === 0) {
    selectItems.push('    1 AS VIEW_STUB_ID');
  }

  const lines = ['SELECT', selectItems.join(',\n')];
  if (upstreamEntities.length > 0) {
    const base = upstreamEntities[0];
    lines.push(
      `FROM ${base.database_schema}.${base.physical_name} ${base.physical_name}`
    );
    const basePks = base.columns
      .filter((c) => c.is_pk)
      .map((c) => c.physical_name);
    for (let i = 1; i < upstreamEntities.length; i++) {
      const joinEnt = upstreamEntities[i];
      const joinCol =
        basePks.find((pk) =>
          joinEnt.columns.some((c) => c.physical_name === pk)
        ) ||
        basePks[0] ||
        'ID';
      lines.push(
        `LEFT JOIN ${joinEnt.database_schema}.${joinEnt.physical_name} ${joinEnt.physical_name}\n    ON ${base.physical_name}.${joinCol} = ${joinEnt.physical_name}.${joinCol}`
      );
    }
  }
  if (hasAgg && groupByItems.length > 0) {
    lines.push(`GROUP BY ${groupByItems.join(', ')}`);
  }
  return lines.join('\n');
}

export type WorkspaceView = 'canvas' | 'dictionary' | 'editor' | 'split';

interface ModelStoreState {
  project: ProjectMetamodel;
  pastProjects: ProjectMetamodel[];
  futureProjects: ProjectMetamodel[];

  viewMode: ViewMode;
  targetDialect: TargetDialect;
  activeSubjectArea: string;

  selectedEntityId: string | null;
  selectedColumnId: string | null;
  selectedRelationshipId: string | null;

  isAuthenticated: boolean;
  currentUser: UserProfile;
  authToken: string | null;

  compiledOutput: CompileResponse | null;
  isCompiling: boolean;
  isSaving: boolean;
  isGeneratingMetadata: boolean;
  statusBanner: { type: 'info' | 'success' | 'error'; message: string } | null;

  // UI Drawer / Modal toggles
  isCodeDrawerOpen: boolean;
  isAgentSidebarOpen: boolean;
  workspaceView: WorkspaceView;
  isCompareModalOpen: boolean;
  compareModalTab: 'compare' | 'reverse';
  isLoginModalOpen: boolean;

  // Actions
  loadInitialProject: () => Promise<void>;
  setProject: (project: ProjectMetamodel, recordHistory?: boolean) => void;
  saveProjectToServer: (commitMessage?: string) => Promise<void>;
  refreshCompiledCode: () => Promise<void>;

  undo: () => void;
  redo: () => void;

  setViewMode: (mode: ViewMode) => void;
  setTargetDialect: (dialect: TargetDialect) => void;
  setActiveSubjectArea: (sa: string) => void;
  addSubjectArea: (sa: string) => void;

  selectEntity: (entityId: string | null, columnId?: string | null) => void;
  selectRelationship: (relId: string | null) => void;

  // Entity & View CRUD
  addEntity: (partial?: Partial<EntityModel>) => string;
  addView: (isMaterialized?: boolean) => string;
  updateEntity: (entityId: string, patch: Partial<EntityModel>) => void;
  updateEntityPosition: (entityId: string, position: EntityPosition) => void;
  applyLayoutPositions: (positions: Record<string, EntityPosition>) => void;
  deleteEntity: (entityId: string) => void;
  importColumnsFromUpstream: (
    viewEntityId: string,
    upstreamEntityId: string
  ) => void;

  // Column CRUD & Drag Reorder
  addColumn: (entityId: string, partial?: Partial<ColumnModel>) => string;
  updateColumn: (
    entityId: string,
    columnId: string,
    patch: Partial<ColumnModel>
  ) => void;
  reorderColumn: (entityId: string, fromIndex: number, toIndex: number) => void;
  deleteColumn: (entityId: string, columnId: string) => void;

  // Relationship CRUD + Automatic FK Migration & Upstream/Downstream Lineage
  connectEntitiesWithRelationship: (
    parentEntityId: string,
    childEntityId: string,
    parentColumnId?: string | null,
    childColumnId?: string | null,
    relType?: RelationshipType,
    cardinality?: Cardinality
  ) => void;
  updateRelationship: (relId: string, patch: Partial<RelationshipModel>) => void;
  toggleRelationshipType: (relId: string) => void;
  toggleRelationshipMandatory: (relId: string) => void;
  cycleRelationshipCardinality: (relId: string) => void;
  deleteRelationship: (relId: string) => void;

  // Domains & Glossary
  upsertDomain: (domain: EnterpriseDomain) => Promise<void>;
  deleteDomain: (domainId: string) => void;
  updateGlossaryEntry: (word: string, abbr: string) => void;
  deleteGlossaryEntry: (word: string) => void;
  applyNamingGlossaryAll: () => Promise<void>;

  // Sticky Notes
  addStickyNote: () => void;
  updateStickyNote: (noteId: string, patch: Partial<StickyNoteModel>) => void;
  deleteStickyNote: (noteId: string) => void;

  // Governance, AI Auto-Metadata, Data Profiling & Modeling Patterns
  autoGenerateMetadata: (entityId?: string | null) => Promise<void>;
  runDataProfiler: (entityId?: string | null) => Promise<void>;
  applyRecommendedDq: (entityId?: string | null) => Promise<void>;
  applyModelingPattern: (
    entityId: string,
    pattern: 'SCD_TYPE_2' | 'DATA_VAULT_HUB' | 'ENTERPRISE_AUDIT'
  ) => Promise<void>;
  verifyMetadata: (entityId: string, columnId?: string | null) => void;

  // Auth & UI
  loginAsUser: (email: string, password?: string) => Promise<boolean>;
  logout: () => void;
  setCodeDrawerOpen: (open: boolean) => void;
  setAgentSidebarOpen: (open: boolean) => void;
  setWorkspaceView: (view: WorkspaceView) => void;
  focusEntity: (entityId: string, columnId?: string | null) => void;
  openCompareModal: (tab?: 'compare' | 'reverse') => void;
  closeCompareModal: () => void;
  setLoginModalOpen: (open: boolean) => void;
  isApiKeyModalOpen: boolean;
  setApiKeyModalOpen: (open: boolean) => void;
  isMcpModalOpen: boolean;
  setMcpModalOpen: (open: boolean) => void;
  isRemoteRepoModalOpen: boolean;
  setRemoteRepoModalOpen: (open: boolean) => void;

  // Remote Model Repository, Checkout Locking, ACL & 3-Way Auto-Reapply
  workspaceMode: 'standalone' | 'remote';
  remoteRepoUrl: string;
  remoteModels: RemoteModelSummary[];
  activeRemoteModel: RemoteModelSummary | null;
  remoteWorkMode: RemoteWorkMode;
  activeCheckoutId: string | null;
  lastMergeReport: ReapplyMergeReport | null;
  connectToRemoteRepository: (repoUrl?: string) => Promise<boolean>;
  disconnectFromRemoteRepository: () => Promise<void>;
  refreshRemoteModels: () => Promise<void>;
  openRemoteModelViewOnly: (modelId: string) => Promise<void>;
  checkoutActiveRemoteModel: (modelId?: string) => Promise<boolean>;
  checkinActiveRemoteModel: (commitMessage?: string, modelId?: string) => Promise<boolean>;
  releaseActiveRemoteModelLock: (modelId?: string) => Promise<boolean>;
  forceReleaseRemoteModel: (modelId: string, reason?: string) => Promise<boolean>;
  reapplyRemoteModelChanges: (modelId?: string) => Promise<CheckoutAndReapplyResponse | null>;
  clearMergeReport: () => void;

  setStatusBanner: (
    banner: { type: 'info' | 'success' | 'error'; message: string } | null
  ) => void;
}

export const useModelStore = create<ModelStoreState>((set, get) => ({
  project: INITIAL_FALLBACK_PROJECT,
  pastProjects: [],
  futureProjects: [],

  viewMode: 'physical',
  targetDialect: 'snowflake',
  activeSubjectArea: 'All',

  selectedEntityId: 'ent-dim-customer',
  selectedColumnId: null,
  selectedRelationshipId: null,

  isAuthenticated: false,
  currentUser: DEFAULT_ADMIN_USER,
  authToken: null,

  compiledOutput: null,
  isCompiling: false,
  isSaving: false,
  isGeneratingMetadata: false,
  statusBanner: null,

  isCodeDrawerOpen: false,
  isAgentSidebarOpen: true,
  workspaceView: 'canvas',
  isCompareModalOpen: false,
  compareModalTab: 'compare',
  isLoginModalOpen: false,
  isApiKeyModalOpen: false,
  isMcpModalOpen: false,
  isRemoteRepoModalOpen: false,

  workspaceMode: 'standalone',
  remoteRepoUrl:
    typeof window !== 'undefined'
      ? localStorage.getItem('metaforge_remote_repo_url') ||
        'http://127.0.0.1:8000/api/remote-models'
      : 'http://127.0.0.1:8000/api/remote-models',
  remoteModels: [],
  activeRemoteModel: null,
  remoteWorkMode: 'view_only',
  activeCheckoutId: null,
  lastMergeReport: null,

  loadInitialProject: async () => {
    try {
      const token = get().authToken;
      if (get().workspaceMode === 'remote') {
        await get().connectToRemoteRepository(get().remoteRepoUrl);
        return;
      }

      // Default: Standalone Local Workspace Mode
      const proj = await api.getProject(token);
      const firstEntId = Object.keys(proj.entities)[0] || null;
      set({
        workspaceMode: 'standalone',
        activeRemoteModel: null,
        project: proj,
        selectedEntityId: firstEntId,
        pastProjects: [],
        futureProjects: [],
      });
      await get().refreshCompiledCode();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Failed to load workspace model';
      set({ statusBanner: { type: 'error', message: msg } });
    }
  },

  setProject: (project, recordHistory = true) => {
    const state = get();
    if (
      recordHistory &&
      state.activeRemoteModel &&
      state.remoteWorkMode !== 'checked_out_by_me'
    ) {
      const m = state.activeRemoteModel;
      if (state.remoteWorkMode === 'revoked_checkout' || m.revoked_session) {
        set({
          statusBanner: {
            type: 'error',
            message: `Checkout Force-Released by Admin: Model '${m.name}' is read-only until you click 'Re-Apply Non-Conflicting Changes' when available for checkout.`,
          },
        });
      } else if (m.is_locked && m.checked_out_by_email) {
        set({
          statusBanner: {
            type: 'error',
            message: `View-Only Mode: '${m.name}' is currently checked out and locked by ${m.checked_out_by_name} (${m.checked_out_by_email}).`,
          },
        });
      } else {
        set({
          statusBanner: {
            type: 'error',
            message: `View-Only Mode: '${m.name}' is opened from the Remote Repository without checkout. Click 'Check Out & Lock' in the toolbar to download locally and edit.`,
          },
        });
      }
      return;
    }

    set((prev) => ({
      pastProjects: recordHistory
        ? [...prev.pastProjects.slice(-29), cloneProject(prev.project)]
        : prev.pastProjects,
      futureProjects: recordHistory ? [] : prev.futureProjects,
      project,
    }));

    if (
      recordHistory &&
      state.activeRemoteModel &&
      state.remoteWorkMode === 'checked_out_by_me'
    ) {
      api
        .saveRemoteDraft(
          state.activeRemoteModel.id,
          project,
          state.activeCheckoutId,
          state.authToken
        )
        .catch(() => {});
    }
  },

  saveProjectToServer: async (
    commitMessage = 'Saved model changes from Studio Canvas'
  ) => {
    const {
      project,
      activeSubjectArea,
      authToken,
      activeRemoteModel,
      remoteWorkMode,
      activeCheckoutId,
    } = get();

    if (activeRemoteModel && remoteWorkMode !== 'checked_out_by_me') {
      set({
        statusBanner: {
          type: 'error',
          message: `Cannot save: '${activeRemoteModel.name}' is in View-Only mode. Check out the model first to save or check in changes.`,
        },
      });
      return;
    }

    set({ isSaving: true });
    try {
      if (activeRemoteModel && remoteWorkMode === 'checked_out_by_me') {
        await api.saveRemoteDraft(
          activeRemoteModel.id,
          project,
          activeCheckoutId,
          authToken
        );
      }
      const saved = await api.saveProject(
        project,
        commitMessage,
        activeSubjectArea,
        authToken
      );
      set({
        project: saved,
        isSaving: false,
        statusBanner: {
          type: 'success',
          message: activeRemoteModel
            ? `Saved local checkout draft for '${activeRemoteModel.name}'. Click 'Check In' when ready to publish & unlock.`
            : `Saved to workspace_model/canonical_model.json (${commitMessage})`,
        },
      });
      await get().refreshCompiledCode();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      set({
        isSaving: false,
        statusBanner: { type: 'error', message: msg },
      });
    }
  },

  refreshCompiledCode: async () => {
    const { project, activeSubjectArea, authToken } = get();
    if (!project || Object.keys(project.entities).length === 0) return;
    set({ isCompiling: true });
    try {
      const compiled = await api.compileProject(
        project,
        activeSubjectArea,
        authToken
      );
      set({ compiledOutput: compiled, isCompiling: false });
    } catch {
      set({ isCompiling: false });
    }
  },

  undo: () => {
    const { pastProjects, project, futureProjects } = get();
    if (pastProjects.length === 0) return;
    const previous = pastProjects[pastProjects.length - 1];
    const remainingPast = pastProjects.slice(0, -1);
    set({
      project: previous,
      pastProjects: remainingPast,
      futureProjects: [cloneProject(project), ...futureProjects.slice(0, 29)],
      statusBanner: { type: 'info', message: 'Undo applied (Ctrl+Z)' },
    });
  },

  redo: () => {
    const { pastProjects, project, futureProjects } = get();
    if (futureProjects.length === 0) return;
    const next = futureProjects[0];
    const remainingFuture = futureProjects.slice(1);
    set({
      project: next,
      pastProjects: [...pastProjects.slice(-29), cloneProject(project)],
      futureProjects: remainingFuture,
      statusBanner: { type: 'info', message: 'Redo applied (Ctrl+Y)' },
    });
  },

  setViewMode: (viewMode) => set({ viewMode }),
  setTargetDialect: (targetDialect) => set({ targetDialect }),
  setActiveSubjectArea: (activeSubjectArea) => set({ activeSubjectArea }),

  addSubjectArea: (sa) => {
    const trimmed = sa.trim();
    if (!trimmed) return;
    const next = cloneProject(get().project);
    if (!next.subject_areas.includes(trimmed)) {
      next.subject_areas.push(trimmed);
      get().setProject(next, true);
      set({ activeSubjectArea: trimmed });
    }
  },

  selectEntity: (entityId, columnId = null) =>
    set({
      selectedEntityId: entityId,
      selectedColumnId: columnId,
      selectedRelationshipId: null,
    }),

  selectRelationship: (relId) =>
    set({
      selectedRelationshipId: relId,
      selectedEntityId: null,
      selectedColumnId: null,
    }),

  addEntity: (partial) => {
    const state = get();
    if (
      state.currentUser.role === 'Viewer' ||
      state.currentUser.role === 'Data Steward'
    ) {
      set({
        statusBanner: {
          type: 'error',
          message: `RBAC Policy: Role '${state.currentUser.role}' cannot create new physical entities.`,
        },
      });
      return '';
    }
    const next = cloneProject(state.project);
    const count = Object.keys(next.entities).length + 1;
    const id = `ent-custom-${Date.now().toString(36)}`;
    const sa =
      state.activeSubjectArea === 'All' ? 'Core' : state.activeSubjectArea;
    const logicalName = partial?.logical_name || `Business Entity ${count}`;
    const physicalName =
      partial?.physical_name ||
      `DIM_${translateLogicalToPhysicalLocal(
        logicalName,
        next.glossary.abbreviations
      )}`;

    const pkColId = `col-${Date.now().toString(36)}-pk`;
    const newEntity: EntityModel = {
      id,
      entity_type: partial?.entity_type || 'table',
      logical_name: logicalName,
      physical_name: physicalName,
      database_schema: sa.toUpperCase(),
      subject_area: sa,
      description:
        partial?.description || `Enterprise table for ${logicalName}.`,
      header_color: partial?.header_color || '#2563eb',
      position: partial?.position || {
        x: 200 + ((count * 90) % 500),
        y: 180 + ((count * 70) % 360),
      },
      dbt_materialization: 'table',
      dbt_layer: 'mart',
      dbt_unique_key: `${physicalName.replace(/^(DIM_|FCT_|STG_|VW_)/, '')}_ID`,
      tags: ['gold'],
      snowflake_props: {
        transient: false,
        cluster_by: [],
        data_retention_days: 7,
        tags: { DATA_DOMAIN: sa.toUpperCase() },
      },
      sql_server_props: {
        schema_name: 'dbo',
        filegroup: 'PRIMARY',
        clustered_columnstore: false,
        system_versioned_temporal: false,
      },
      oracle_props: {
        schema_name: 'CORE_DATA',
        tablespace: 'USERS',
        index_tablespace: 'USERS_IDX',
        partition_by_range_col: null,
        pctfree: 10,
        compress_for_oltp: false,
      },
      columns: partial?.columns || [
        {
          id: pkColId,
          logical_name: `${logicalName} Identifier`,
          physical_name: `${physicalName.replace(/^(DIM_|FCT_|STG_|VW_)/, '')}_ID`,
          domain_id: 'dom-surrogate-id',
          data_type_snowflake: 'NUMBER(38,0)',
          data_type_sql_server: 'BIGINT',
          data_type_oracle: 'NUMBER(19,0)',
          is_pk: true,
          is_fk: false,
          is_nullable: false,
          is_unique: true,
          is_identity: true,
          default_value: null,
          description: `Surrogate primary key for ${logicalName}.`,
          pii_classification: 'NONE',
          dbt_tests: ['unique', 'not_null'],
        },
      ],
    };

    next.entities[id] = newEntity;
    state.setProject(next, true);
    set({ selectedEntityId: id, selectedColumnId: pkColId });
    return id;
  },

  addView: (isMaterialized = false) => {
    const state = get();
    if (
      state.currentUser.role === 'Viewer' ||
      state.currentUser.role === 'Data Steward'
    ) {
      set({
        statusBanner: {
          type: 'error',
          message: `RBAC Policy: Role '${state.currentUser.role}' cannot create views.`,
        },
      });
      return '';
    }
    const next = cloneProject(state.project);
    const count = Object.keys(next.entities).length + 1;
    const id = `ent-vw-${Date.now().toString(36)}`;
    const sa =
      state.activeSubjectArea === 'All' ? 'Core' : state.activeSubjectArea;
    const prefix = isMaterialized ? 'MV_' : 'VW_';
    const logicalName = `${sa} Analytical View ${count}`;
    const physicalName = `${prefix}${translateLogicalToPhysicalLocal(
      logicalName,
      next.glossary.abbreviations
    )}`;

    const colId = `col-vw-${Date.now().toString(36)}`;
    const newView: EntityModel = {
      id,
      entity_type: isMaterialized ? 'materialized_view' : 'view',
      logical_name: logicalName,
      physical_name: physicalName,
      database_schema: sa.toUpperCase(),
      subject_area: sa,
      description: `Analytical ${isMaterialized ? 'Materialized ' : ''}View with auto-synthesized SQL from upstream tables.`,
      header_color: '#0891b2',
      position: {
        x: 340 + ((count * 80) % 450),
        y: 220 + ((count * 60) % 320),
      },
      view_sql: null,
      dbt_materialization: isMaterialized ? 'table' : 'view',
      dbt_layer: 'mart',
      dbt_unique_key: null,
      tags: ['view', 'analytics'],
      snowflake_props: {
        transient: false,
        cluster_by: [],
        data_retention_days: 1,
        tags: { OBJECT_TYPE: 'VIEW' },
      },
      sql_server_props: {
        schema_name: 'dbo',
        filegroup: 'PRIMARY',
        clustered_columnstore: false,
        system_versioned_temporal: false,
      },
      oracle_props: {
        schema_name: 'CORE_DATA',
        tablespace: 'USERS',
        index_tablespace: 'USERS_IDX',
        partition_by_range_col: null,
        pctfree: 10,
        compress_for_oltp: false,
      },
      columns: [
        {
          id: colId,
          logical_name: 'Summary Metric Amount',
          physical_name: 'SUMMARY_METRIC_AMT',
          domain_id: 'dom-monetary-amount',
          data_type_snowflake: 'NUMBER(18,2)',
          data_type_sql_server: 'DECIMAL(18,2)',
          data_type_oracle: 'NUMBER(18,2)',
          is_pk: false,
          is_fk: false,
          is_nullable: true,
          is_unique: false,
          is_identity: false,
          default_value: null,
          source_expression: '0.00',
          description: 'Projected or aggregated view column.',
          pii_classification: 'NONE',
          dbt_tests: [],
        },
      ],
    };

    next.entities[id] = newView;
    state.setProject(next, true);
    set({
      selectedEntityId: id,
      selectedColumnId: null,
      statusBanner: {
        type: 'success',
        message: `Created View ${physicalName}. Link upstream tables or import columns in the Right Inspector to auto-generate SQL!`,
      },
    });
    return id;
  },

  importColumnsFromUpstream: (viewEntityId, upstreamEntityId) => {
    const state = get();
    const next = cloneProject(state.project);
    const viewEnt = next.entities[viewEntityId];
    const upEnt = next.entities[upstreamEntityId];
    if (!viewEnt || !upEnt) return;

    // Ensure an UPSTREAM_LINEAGE relationship exists between upEnt -> viewEnt
    const hasLineage = Object.values(next.relationships).some(
      (r) =>
        r.parent_entity_id === upEnt.id && r.child_entity_id === viewEnt.id
    );
    const upPk = upEnt.columns.find((c) => c.is_pk) || upEnt.columns[0];

    // Import columns not yet present on the view
    const existingNames = new Set(
      viewEnt.columns.map((c) => c.physical_name.toUpperCase())
    );
    // Remove placeholder dummy column if it's the only one
    if (
      viewEnt.columns.length === 1 &&
      viewEnt.columns[0].physical_name === 'SUMMARY_METRIC_AMT'
    ) {
      viewEnt.columns = [];
    }

    let importedCount = 0;
    upEnt.columns.forEach((uCol) => {
      if (!existingNames.has(uCol.physical_name.toUpperCase())) {
        viewEnt.columns.push({
          ...JSON.parse(JSON.stringify(uCol)),
          id: `col-vw-${Date.now().toString(36)}-${importedCount}`,
          is_pk: false,
          is_fk: false,
          is_identity: false,
          source_expression: `${upEnt.physical_name}.${uCol.physical_name}`,
          description: `Projected from ${upEnt.physical_name}.${uCol.physical_name}`,
        });
        importedCount++;
      }
    });

    if (!hasLineage && upPk && viewEnt.columns.length > 0) {
      const relId = `rel-lin-${Date.now().toString(36)}`;
      next.relationships[relId] = {
        id: relId,
        name: `LINEAGE_${upEnt.physical_name}_TO_${viewEnt.physical_name}`,
        parent_entity_id: upEnt.id,
        child_entity_id: viewEnt.id,
        parent_column_id: upPk.id,
        child_column_id: viewEnt.columns[0].id,
        cardinality: '1:N',
        rel_type: 'upstream_lineage',
        transformation_note: `Projected ${importedCount} column(s) into view ${viewEnt.physical_name}`,
      };
    }

    state.setProject(next, true);
    get().refreshCompiledCode();
    set({
      statusBanner: {
        type: 'success',
        message: `Imported ${importedCount} column(s) from ${upEnt.physical_name} into ${viewEnt.physical_name} and synthesized View SQL!`,
      },
    });
  },

  updateEntity: (entityId, patch) => {
    const state = get();
    if (state.currentUser.role === 'Viewer') {
      set({
        statusBanner: {
          type: 'error',
          message: 'RBAC Policy: Viewer role is read-only.',
        },
      });
      return;
    }
    const next = cloneProject(state.project);
    const existing = next.entities[entityId];
    if (!existing) return;
    next.entities[entityId] = { ...existing, ...patch };
    state.setProject(next, true);
  },

  updateEntityPosition: (entityId, position) => {
    const state = get();
    const next = cloneProject(state.project);
    if (next.entities[entityId]) {
      next.entities[entityId].position = position;
      set({ project: next });
    } else if (next.annotations && next.annotations[entityId]) {
      next.annotations[entityId].position = position;
      set({ project: next });
    }
  },

  applyLayoutPositions: (positions) => {
    const state = get();
    const next = cloneProject(state.project);
    Object.entries(positions).forEach(([entId, pos]) => {
      if (next.entities[entId]) {
        next.entities[entId].position = pos;
      }
    });
    state.setProject(next, true);
    set({
      statusBanner: {
        type: 'info',
        message: 'ELKjs Layered Orthogonal Auto-Layout applied.',
      },
    });
  },

  deleteEntity: (entityId) => {
    const state = get();
    if (
      state.currentUser.role === 'Viewer' ||
      state.currentUser.role === 'Data Steward'
    ) {
      set({
        statusBanner: {
          type: 'error',
          message: `RBAC Policy: Role '${state.currentUser.role}' cannot drop physical entities.`,
        },
      });
      return;
    }
    const next = cloneProject(state.project);
    delete next.entities[entityId];
    Object.keys(next.relationships).forEach((relId) => {
      const r = next.relationships[relId];
      if (
        r.parent_entity_id === entityId ||
        r.child_entity_id === entityId
      ) {
        delete next.relationships[relId];
      }
    });
    state.setProject(next, true);
    set({ selectedEntityId: null, selectedColumnId: null });
  },

  addColumn: (entityId, partial) => {
    const state = get();
    if (
      state.currentUser.role === 'Viewer' ||
      state.currentUser.role === 'Data Steward'
    ) {
      set({
        statusBanner: {
          type: 'error',
          message: `RBAC Policy: Role '${state.currentUser.role}' cannot add physical columns.`,
        },
      });
      return '';
    }
    const next = cloneProject(state.project);
    const ent = next.entities[entityId];
    if (!ent) return '';
    const idx = ent.columns.length + 1;
    const colId = `col-${Date.now().toString(36)}-${idx}`;
    const logicalName = partial?.logical_name || `New Attribute ${idx}`;
    const physicalName =
      partial?.physical_name ||
      translateLogicalToPhysicalLocal(
        logicalName,
        next.glossary.abbreviations
      );

    const newCol: ColumnModel = {
      id: colId,
      logical_name: logicalName,
      physical_name: physicalName,
      domain_id: partial?.domain_id ?? null,
      data_type_snowflake: partial?.data_type_snowflake || 'VARCHAR(255)',
      data_type_sql_server: partial?.data_type_sql_server || 'NVARCHAR(255)',
      data_type_oracle: partial?.data_type_oracle || 'VARCHAR2(255 CHAR)',
      is_pk: partial?.is_pk ?? false,
      is_fk: partial?.is_fk ?? false,
      is_nullable: partial?.is_nullable ?? true,
      is_unique: partial?.is_unique ?? false,
      is_identity: partial?.is_identity ?? false,
      default_value: partial?.default_value ?? null,
      source_expression: partial?.source_expression ?? null,
      description: partial?.description || '',
      pii_classification: partial?.pii_classification || 'NONE',
      dbt_tests: partial?.dbt_tests || [],
    };
    ent.columns.push(newCol);
    state.setProject(next, true);
    set({ selectedEntityId: entityId, selectedColumnId: colId });
    return colId;
  },

  updateColumn: (entityId, columnId, patch) => {
    const state = get();
    if (state.currentUser.role === 'Viewer') return;
    const next = cloneProject(state.project);
    const ent = next.entities[entityId];
    if (!ent) return;
    const colIdx = ent.columns.findIndex((c) => c.id === columnId);
    if (colIdx === -1) return;

    const updatedCol = { ...ent.columns[colIdx], ...patch };

    if (patch.domain_id && next.domains[patch.domain_id]) {
      const dom = next.domains[patch.domain_id];
      updatedCol.data_type_snowflake = dom.snowflake_type;
      updatedCol.data_type_sql_server = dom.sql_server_type;
      updatedCol.data_type_oracle = dom.oracle_type;
      updatedCol.is_nullable = dom.nullable_default;
      const mergedTests = Array.from(
        new Set([...updatedCol.dbt_tests, ...dom.dbt_tests])
      );
      updatedCol.dbt_tests = mergedTests;
    }

    ent.columns[colIdx] = updatedCol;
    state.setProject(next, true);
  },

  reorderColumn: (entityId, fromIndex, toIndex) => {
    const state = get();
    if (fromIndex === toIndex) return;
    const next = cloneProject(state.project);
    const ent = next.entities[entityId];
    if (!ent) return;
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= ent.columns.length ||
      toIndex >= ent.columns.length
    ) {
      return;
    }
    const [moved] = ent.columns.splice(fromIndex, 1);
    ent.columns.splice(toIndex, 0, moved);
    state.setProject(next, true);
  },

  deleteColumn: (entityId, columnId) => {
    const state = get();
    if (
      state.currentUser.role === 'Viewer' ||
      state.currentUser.role === 'Data Steward'
    ) {
      set({
        statusBanner: {
          type: 'error',
          message: `RBAC Policy: Role '${state.currentUser.role}' cannot delete physical columns.`,
        },
      });
      return;
    }
    const next = cloneProject(state.project);
    const ent = next.entities[entityId];
    if (!ent) return;
    ent.columns = ent.columns.filter((c) => c.id !== columnId);
    Object.keys(next.relationships).forEach((relId) => {
      const r = next.relationships[relId];
      if (r.parent_column_id === columnId || r.child_column_id === columnId) {
        delete next.relationships[relId];
      }
    });
    state.setProject(next, true);
    if (state.selectedColumnId === columnId) {
      set({ selectedColumnId: null });
    }
  },

  connectEntitiesWithRelationship: (
    parentEntityId,
    childEntityId,
    parentColumnId,
    childColumnId,
    relType,
    cardinality = '1:N'
  ) => {
    const state = get();
    if (parentEntityId === childEntityId) return;
    if (
      state.currentUser.role === 'Viewer' ||
      state.currentUser.role === 'Data Steward'
    ) {
      set({
        statusBanner: {
          type: 'error',
          message: `RBAC Policy: Role '${state.currentUser.role}' cannot alter physical relationships.`,
        },
      });
      return;
    }

    const next = cloneProject(state.project);
    const parentEnt = next.entities[parentEntityId];
    const childEnt = next.entities[childEntityId];
    if (!parentEnt || !childEnt) return;

    // If connecting into a View or Materialized View, default to upstream_lineage
    const isChildView =
      childEnt.entity_type === 'view' ||
      childEnt.entity_type === 'materialized_view';
    const effectiveRelType: RelationshipType =
      relType || (isChildView ? 'upstream_lineage' : 'non_identifying');

    const parentCol =
      parentEnt.columns.find((c) => c.id === parentColumnId) ||
      parentEnt.columns.find((c) => c.is_pk) ||
      parentEnt.columns[0];
    if (!parentCol) return;

    let childCol =
      childEnt.columns.find((c) => c.id === childColumnId && !c.is_pk) ||
      childEnt.columns.find(
        (c) =>
          c.physical_name.toUpperCase() ===
          parentCol.physical_name.toUpperCase()
      );

    if (!childCol) {
      const migratedColId = `col-fk-${Date.now().toString(36)}`;
      childCol = {
        id: migratedColId,
        logical_name: parentCol.logical_name,
        physical_name: parentCol.physical_name,
        domain_id: parentCol.domain_id,
        data_type_snowflake: parentCol.data_type_snowflake,
        data_type_sql_server: parentCol.data_type_sql_server,
        data_type_oracle: parentCol.data_type_oracle,
        is_pk: effectiveRelType === 'identifying',
        is_fk: effectiveRelType !== 'upstream_lineage',
        is_nullable: effectiveRelType === 'upstream_lineage',
        is_unique: false,
        is_identity: false,
        default_value: null,
        source_expression: isChildView
          ? `${parentEnt.physical_name}.${parentCol.physical_name}`
          : null,
        description:
          effectiveRelType === 'upstream_lineage'
            ? `Projected from upstream ${parentEnt.physical_name}.${parentCol.physical_name}.`
            : `Migrated foreign key referencing ${parentEnt.physical_name}.${parentCol.physical_name}.`,
        pii_classification: parentCol.pii_classification,
        dbt_tests: effectiveRelType === 'upstream_lineage' ? [] : ['not_null'],
      };
      childEnt.columns.push(childCol);
    } else if (effectiveRelType !== 'upstream_lineage') {
      childCol.is_fk = true;
      if (effectiveRelType === 'identifying') {
        childCol.is_pk = true;
        childCol.is_nullable = false;
      }
    }

    const relId = `rel-${Date.now().toString(36)}`;
    const relName =
      effectiveRelType === 'upstream_lineage'
        ? `LINEAGE_${parentEnt.physical_name}_TO_${childEnt.physical_name}`
        : `FK_${childEnt.physical_name}_${parentEnt.physical_name}`;

    next.relationships[relId] = {
      id: relId,
      name: relName,
      parent_entity_id: parentEnt.id,
      child_entity_id: childEnt.id,
      parent_column_id: parentCol.id,
      child_column_id: childCol.id,
      cardinality,
      rel_type: effectiveRelType,
      transformation_note:
        effectiveRelType === 'upstream_lineage'
          ? `Upstream lineage from ${parentEnt.physical_name} to ${childEnt.physical_name}`
          : null,
    };

    state.setProject(next, true);
    get().refreshCompiledCode();
    set({
      selectedRelationshipId: relId,
      statusBanner: {
        type: 'success',
        message: `Connected ${parentEnt.physical_name}.${parentCol.physical_name} → ${childEnt.physical_name}.${childCol.physical_name} [${effectiveRelType}, ${cardinality}]`,
      },
    });
  },

  updateRelationship: (relId, patch) => {
    const state = get();
    const next = cloneProject(state.project);
    const rel = next.relationships[relId];
    if (!rel) return;
    const updated = { ...rel, ...patch };
    next.relationships[relId] = updated;

    if (patch.rel_type || patch.is_mandatory !== undefined) {
      const childEnt = next.entities[updated.child_entity_id];
      const childCol = childEnt?.columns.find(
        (c) => c.id === updated.child_column_id
      );
      if (childCol) {
        if (patch.rel_type) {
          childCol.is_pk = patch.rel_type === 'identifying';
          childCol.is_fk = patch.rel_type !== 'upstream_lineage';
          if (childCol.is_pk) childCol.is_nullable = false;
        }
        if (patch.is_mandatory !== undefined) {
          childCol.is_nullable = !patch.is_mandatory;
        }
      }
    }
    state.setProject(next, true);
  },

  toggleRelationshipType: (relId) => {
    const rel = get().project.relationships[relId];
    if (!rel) return;
    const order: RelationshipType[] = [
      'non_identifying',
      'identifying',
      'upstream_lineage',
    ];
    const idx = order.indexOf(rel.rel_type);
    const nextType = order[(idx + 1) % order.length];
    get().updateRelationship(relId, { rel_type: nextType });
  },

  toggleRelationshipMandatory: (relId) => {
    const rel = get().project.relationships[relId];
    if (!rel) return;
    const currentMandatory = rel.is_mandatory !== undefined ? rel.is_mandatory : true;
    const nextMandatory = !currentMandatory;
    const nextCard: Cardinality = nextMandatory
      ? (rel.cardinality.startsWith('0') ? (rel.cardinality === '0:1' ? '1:1' : '1:N') : rel.cardinality)
      : (rel.cardinality.startsWith('1') ? (rel.cardinality === '1:1' ? '0:1' : '0:N') : rel.cardinality);
    get().updateRelationship(relId, { is_mandatory: nextMandatory, cardinality: nextCard });
  },

  cycleRelationshipCardinality: (relId) => {
    const rel = get().project.relationships[relId];
    if (!rel) return;
    const order: Cardinality[] = ['1:N', '0:N', '1:1', '0:1'];
    const idx = order.indexOf(rel.cardinality);
    const nextCard = order[(idx + 1) % order.length];
    get().updateRelationship(relId, { cardinality: nextCard });
  },

  deleteRelationship: (relId) => {
    const state = get();
    const next = cloneProject(state.project);
    delete next.relationships[relId];
    state.setProject(next, true);
    if (state.selectedRelationshipId === relId) {
      set({ selectedRelationshipId: null });
    }
  },

  upsertDomain: async (domain) => {
    const state = get();
    try {
      const updatedModel = await api.cascadeDomain(
        domain,
        state.project,
        state.authToken
      );
      state.setProject(updatedModel, true);
      set({
        statusBanner: {
          type: 'success',
          message: `Enterprise Domain '${domain.name}' saved and cascaded to all bound columns.`,
        },
      });
      await get().refreshCompiledCode();
    } catch {
      const next = cloneProject(state.project);
      next.domains[domain.id] = domain;
      Object.values(next.entities).forEach((ent) => {
        ent.columns.forEach((col) => {
          if (col.domain_id === domain.id) {
            col.data_type_snowflake = domain.snowflake_type;
            col.data_type_sql_server = domain.sql_server_type;
            col.data_type_oracle = domain.oracle_type;
          }
        });
      });
      state.setProject(next, true);
    }
  },

  deleteDomain: (domainId) => {
    const state = get();
    const next = cloneProject(state.project);
    delete next.domains[domainId];
    Object.values(next.entities).forEach((ent) => {
      ent.columns.forEach((col) => {
        if (col.domain_id === domainId) col.domain_id = null;
      });
    });
    state.setProject(next, true);
  },

  updateGlossaryEntry: (word, abbr) => {
    const state = get();
    const next = cloneProject(state.project);
    next.glossary.abbreviations[word.toUpperCase().trim()] = abbr
      .toUpperCase()
      .trim();
    state.setProject(next, true);
  },

  deleteGlossaryEntry: (word) => {
    const state = get();
    const next = cloneProject(state.project);
    delete next.glossary.abbreviations[word.toUpperCase()];
    state.setProject(next, true);
  },

  applyNamingGlossaryAll: async () => {
    const state = get();
    try {
      const updated = await api.applyNamingGlossary(
        state.project,
        state.authToken
      );
      state.setProject(updated, true);
      set({
        statusBanner: {
          type: 'success',
          message:
            'Enterprise Naming Standards Glossary auto-translation applied across project.',
        },
      });
      await get().refreshCompiledCode();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Failed to apply glossary';
      set({ statusBanner: { type: 'error', message: msg } });
    }
  },

  addStickyNote: () => {
    const state = get();
    const next = cloneProject(state.project);
    if (!next.annotations) next.annotations = {};
    const id = `note-${Date.now().toString(36)}`;
    const sa =
      state.activeSubjectArea === 'All' ? 'Core' : state.activeSubjectArea;
    next.annotations[id] = {
      id,
      text: 'Architecture Annotation:\nDocument business rules or SLA targets here.',
      color: '#fef08a',
      subject_area: sa,
      position: { x: 220, y: 220 },
    };
    state.setProject(next, true);
  },

  updateStickyNote: (noteId, patch) => {
    const state = get();
    const next = cloneProject(state.project);
    if (!next.annotations || !next.annotations[noteId]) return;
    next.annotations[noteId] = { ...next.annotations[noteId], ...patch };
    state.setProject(next, false);
  },

  deleteStickyNote: (noteId) => {
    const state = get();
    const next = cloneProject(state.project);
    if (next.annotations) {
      delete next.annotations[noteId];
      state.setProject(next, true);
    }
  },

  autoGenerateMetadata: async (entityId) => {
    const state = get();
    const email = state.currentUser?.email || '';
    const geminiApiKey =
      (email ? localStorage.getItem(`metaforge_gemini_key_${email}`) : null) ||
      localStorage.getItem('metaforge_gemini_api_key');
    const geminiModel =
      (email ? localStorage.getItem(`metaforge_gemini_model_${email}`) : null) ||
      localStorage.getItem('metaforge_gemini_model') ||
      'gemini-2.5-flash';
    set({
      isGeneratingMetadata: true,
      statusBanner: {
        type: 'info',
        message: geminiApiKey
          ? `Calling Google Gemini (${geminiModel}) to generate enterprise metadata & definitions...`
          : 'Synthesizing context-rich enterprise metadata & governance definitions...',
      },
    });
    try {
      const res = await api.autoGenerateMetadata(
        state.project,
        entityId,
        true,
        geminiApiKey,
        geminiModel,
        state.authToken
      );
      state.setProject(res.project, true);
      const providerLabel = res.stats.ai_provider || 'Google Gemini';
      set({
        statusBanner: {
          type: 'success',
          message: `${providerLabel}: Successfully generated business definitions, Kimball grain, and retention policies (${res.stats.entities_updated} entities, ${res.stats.columns_updated} columns).`,
        },
      });
      await get().refreshCompiledCode();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Auto-metadata generation failed';
      set({ statusBanner: { type: 'error', message: msg } });
    } finally {
      set({ isGeneratingMetadata: false });
    }
  },

  runDataProfiler: async (entityId) => {
    const state = get();
    try {
      const res = await api.runDataProfiler(
        state.project,
        entityId,
        state.authToken
      );
      state.setProject(res.project, true);
      set({
        statusBanner: {
          type: 'success',
          message: `Profiled ${res.stats.entities_profiled} table(s), ${res.stats.columns_profiled} columns — discovered ${res.stats.total_recommendations} DQ recommendations.`,
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Data profiling failed';
      set({ statusBanner: { type: 'error', message: msg } });
    }
  },

  applyRecommendedDq: async (entityId) => {
    const state = get();
    try {
      const res = await api.applyRecommendedDq(
        state.project,
        entityId,
        state.authToken
      );
      state.setProject(res.project, true);
      set({
        statusBanner: {
          type: 'success',
          message: `Applied ${res.stats.rules_applied} recommended DQ tests, CHECK constraints, and clustering keys!`,
        },
      });
      await get().refreshCompiledCode();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Applying DQ recommendations failed';
      set({ statusBanner: { type: 'error', message: msg } });
    }
  },

  applyModelingPattern: async (entityId, pattern) => {
    const state = get();
    try {
      const res = await api.applyModelingPattern(
        state.project,
        entityId,
        pattern,
        state.authToken
      );
      state.setProject(res.project, true);
      set({
        statusBanner: {
          type: 'success',
          message: `Applied ${res.stats.pattern} pattern to ${res.stats.entity} (added ${res.stats.columns_added.length} columns: ${res.stats.columns_added.join(', ')}).`,
        },
      });
      await get().refreshCompiledCode();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Applying modeling pattern failed';
      set({ statusBanner: { type: 'error', message: msg } });
    }
  },

  verifyMetadata: (entityId, columnId) => {
    const state = get();
    if (state.currentUser.role === 'Viewer') return;
    const next = cloneProject(state.project);
    const ent = next.entities[entityId];
    if (!ent) return;
    if (columnId) {
      const col = ent.columns.find((c) => c.id === columnId);
      if (col) col.metadata_status = 'STEWARD_VERIFIED';
    } else {
      ent.metadata_status = 'STEWARD_VERIFIED';
      ent.columns.forEach((c) => {
        c.metadata_status = 'STEWARD_VERIFIED';
      });
    }
    state.setProject(next, true);
    set({
      statusBanner: {
        type: 'success',
        message: `Marked ${columnId ? 'column' : ent.physical_name} business definitions as STEWARD_VERIFIED.`,
      },
    });
  },

  loginAsUser: async (email, password = 'password123') => {
    try {
      const res = await api.login(email, password);
      set({
        isAuthenticated: true,
        authToken: res.access_token,
        currentUser: res.user,
        isLoginModalOpen: false,
        statusBanner: {
          type: 'success',
          message: `Signed in as ${res.user.full_name} [${res.user.role}]`,
        },
      });
      await get().loadInitialProject();
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Login failed';
      set({ statusBanner: { type: 'error', message: msg } });
      return false;
    }
  },

  logout: () => {
    set({
      isAuthenticated: false,
      authToken: null,
      isLoginModalOpen: false,
    });
  },

  setCodeDrawerOpen: (isCodeDrawerOpen) => {
    set({ isCodeDrawerOpen });
    if (isCodeDrawerOpen) {
      get().refreshCompiledCode();
    }
  },
  setAgentSidebarOpen: (isAgentSidebarOpen) => set({ isAgentSidebarOpen }),
  setWorkspaceView: (workspaceView) => set({ workspaceView }),
  focusEntity: (entityId, columnId = null) => {
    const ent = get().project.entities[entityId];
    if (!ent) return;
    const sa = get().activeSubjectArea;
    if (sa !== 'All' && ent.subject_area.toLowerCase() !== sa.toLowerCase()) {
      set({ activeSubjectArea: 'All' });
    }
    get().selectEntity(entityId, columnId);
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('metaforge:focus-entity', { detail: { entityId } }));
    }, 50);
  },
  openCompareModal: (tab = 'compare') =>
    set({ isCompareModalOpen: true, compareModalTab: tab }),
  closeCompareModal: () => set({ isCompareModalOpen: false }),
  setLoginModalOpen: (isLoginModalOpen) => set({ isLoginModalOpen }),
  setApiKeyModalOpen: (isApiKeyModalOpen) => set({ isApiKeyModalOpen }),
  setMcpModalOpen: (isMcpModalOpen) => set({ isMcpModalOpen }),
  setRemoteRepoModalOpen: (isRemoteRepoModalOpen) => {
    set({ isRemoteRepoModalOpen });
    if (isRemoteRepoModalOpen) {
      get().refreshRemoteModels();
    }
  },

  connectToRemoteRepository: async (repoUrl) => {
    try {
      const effectiveUrl = (repoUrl || get().remoteRepoUrl).trim();
      if (typeof window !== 'undefined' && effectiveUrl) {
        localStorage.setItem('metaforge_remote_repo_url', effectiveUrl);
      }
      const token = get().authToken;
      const models = await api.listRemoteModels(token);
      const currentActiveId = get().activeRemoteModel?.id;
      const target =
        models.find((m) => m.id === currentActiveId) ||
        models.find((m) => m.id === 'model-enterprise-insurance') ||
        models[0];

      if (target) {
        const userEmail = get().currentUser.email.toLowerCase();
        if (
          target.is_locked &&
          target.checked_out_by_email &&
          target.checked_out_by_email.toLowerCase() === userEmail
        ) {
          const coDetail = await api.checkoutRemoteModel(target.id, token);
          const firstEntId = Object.keys(coDetail.project.entities)[0] || null;
          set({
            workspaceMode: 'remote',
            remoteRepoUrl: effectiveUrl,
            remoteModels: models,
            activeRemoteModel: coDetail.summary,
            remoteWorkMode: 'checked_out_by_me',
            activeCheckoutId:
              coDetail.active_checkout_id || coDetail.summary.checkout_id || null,
            project: coDetail.project,
            selectedEntityId: firstEntId,
            pastProjects: [],
            futureProjects: [],
            statusBanner: {
              type: 'success',
              message: `Connected to Remote Repository (${effectiveUrl}). Restored your active checkout lock on '${coDetail.summary.name}'.`,
            },
          });
        } else {
          const viewDetail = await api.viewRemoteModel(target.id, token);
          const firstEntId = Object.keys(viewDetail.project.entities)[0] || null;
          const effectiveMode: RemoteWorkMode = target.revoked_session
            ? 'revoked_checkout'
            : viewDetail.work_mode;
          set({
            workspaceMode: 'remote',
            remoteRepoUrl: effectiveUrl,
            remoteModels: models,
            activeRemoteModel: viewDetail.summary,
            remoteWorkMode: effectiveMode,
            activeCheckoutId: target.revoked_session?.checkout_id || null,
            project: viewDetail.project,
            selectedEntityId: firstEntId,
            pastProjects: [],
            futureProjects: [],
            statusBanner: {
              type: 'success',
              message: `Connected to Shared Remote Repository. Viewing '${viewDetail.summary.name}' (${viewDetail.summary.version_tag}) in View-Only mode.`,
            },
          });
        }
        await get().refreshCompiledCode();
      } else {
        set({
          workspaceMode: 'remote',
          remoteRepoUrl: effectiveUrl,
          remoteModels: models,
          statusBanner: {
            type: 'info',
            message: 'Connected to Remote Repository.',
          },
        });
      }
      return true;
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Failed to connect to Remote Repository';
      set({ statusBanner: { type: 'error', message: msg } });
      return false;
    }
  },

  disconnectFromRemoteRepository: async () => {
    try {
      const token = get().authToken;
      const localProj = await api.getProject(token);
      const firstEntId = Object.keys(localProj.entities)[0] || null;
      set({
        workspaceMode: 'standalone',
        activeRemoteModel: null,
        remoteWorkMode: 'view_only',
        activeCheckoutId: null,
        project: localProj,
        selectedEntityId: firstEntId,
        pastProjects: [],
        futureProjects: [],
        statusBanner: {
          type: 'info',
          message:
            'Disconnected from Remote Repository. Working in Local Standalone Mode (unrestricted local editing & saving).',
        },
      });
      await get().refreshCompiledCode();
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Failed to switch to Standalone mode';
      set({ statusBanner: { type: 'error', message: msg } });
    }
  },

  refreshRemoteModels: async () => {
    try {
      const token = get().authToken;
      const models = await api.listRemoteModels(token);
      if (get().workspaceMode !== 'remote') {
        set({ remoteModels: models });
        return;
      }

      const currentActive = get().activeRemoteModel;
      const updatedActive = currentActive
        ? models.find((m) => m.id === currentActive.id) || currentActive
        : models[0] || null;

      let nextMode = get().remoteWorkMode;
      const userEmail = get().currentUser.email.toLowerCase();
      if (updatedActive) {
        if (
          updatedActive.is_locked &&
          updatedActive.checked_out_by_email?.toLowerCase() === userEmail
        ) {
          nextMode = 'checked_out_by_me';
        } else if (updatedActive.revoked_session) {
          nextMode = 'revoked_checkout';
        } else {
          nextMode = 'view_only';
        }
      }

      set({
        remoteModels: models,
        activeRemoteModel: updatedActive,
        remoteWorkMode: nextMode,
      });
    } catch {
      // ignore background refresh errors
    }
  },

  openRemoteModelViewOnly: async (modelId) => {
    try {
      const token = get().authToken;
      const detail = await api.viewRemoteModel(modelId, token);
      const models = await api.listRemoteModels(token);
      const firstEntId = Object.keys(detail.project.entities)[0] || null;
      const effectiveMode: RemoteWorkMode = detail.summary.revoked_session
        ? 'revoked_checkout'
        : 'view_only';
      set({
        workspaceMode: 'remote',
        remoteModels: models,
        activeRemoteModel: detail.summary,
        remoteWorkMode: effectiveMode,
        activeCheckoutId: detail.summary.revoked_session?.checkout_id || null,
        project: detail.project,
        selectedEntityId: firstEntId,
        pastProjects: [],
        futureProjects: [],
        statusBanner: {
          type: 'info',
          message: detail.message,
        },
      });
      await get().refreshCompiledCode();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Failed to view remote model';
      set({ statusBanner: { type: 'error', message: msg } });
    }
  },

  checkoutActiveRemoteModel: async (modelId) => {
    const targetId = modelId || get().activeRemoteModel?.id;
    if (!targetId) return false;
    try {
      const token = get().authToken;
      const detail = await api.checkoutRemoteModel(targetId, token);
      const models = await api.listRemoteModels(token);
      const firstEntId = Object.keys(detail.project.entities)[0] || null;
      set({
        workspaceMode: 'remote',
        remoteModels: models,
        activeRemoteModel: detail.summary,
        remoteWorkMode: 'checked_out_by_me',
        activeCheckoutId: detail.active_checkout_id || detail.summary.checkout_id || null,
        project: detail.project,
        selectedEntityId: get().selectedEntityId || firstEntId,
        pastProjects: [],
        futureProjects: [],
        statusBanner: {
          type: 'success',
          message: detail.message,
        },
      });
      await get().refreshCompiledCode();
      return true;
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Checkout failed';
      set({ statusBanner: { type: 'error', message: msg } });
      await get().refreshRemoteModels();
      return false;
    }
  },

  checkinActiveRemoteModel: async (
    commitMessage = 'Checked in model changes to shared repository',
    modelId
  ) => {
    const targetId = modelId || get().activeRemoteModel?.id;
    if (!targetId) return false;
    set({ isSaving: true });
    try {
      const { project, activeCheckoutId, authToken } = get();
      const detail = await api.checkinRemoteModel(
        targetId,
        project,
        commitMessage,
        activeCheckoutId,
        authToken
      );
      const models = await api.listRemoteModels(authToken);
      set({
        isSaving: false,
        remoteModels: models,
        activeRemoteModel: detail.summary,
        remoteWorkMode: 'view_only',
        activeCheckoutId: null,
        project: detail.project,
        statusBanner: {
          type: 'success',
          message: detail.message,
        },
      });
      await get().refreshCompiledCode();
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Check-in failed';
      set({
        isSaving: false,
        statusBanner: { type: 'error', message: msg },
      });
      await get().refreshRemoteModels();
      return false;
    }
  },

  releaseActiveRemoteModelLock: async (modelId) => {
    const targetId = modelId || get().activeRemoteModel?.id;
    if (!targetId) return false;
    try {
      const token = get().authToken;
      const detail = await api.releaseRemoteModelLock(targetId, token);
      const models = await api.listRemoteModels(token);
      set({
        remoteModels: models,
        activeRemoteModel: detail.summary,
        remoteWorkMode: 'view_only',
        activeCheckoutId: null,
        project: detail.project,
        statusBanner: {
          type: 'info',
          message: detail.message,
        },
      });
      await get().refreshCompiledCode();
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to release lock';
      set({ statusBanner: { type: 'error', message: msg } });
      return false;
    }
  },

  forceReleaseRemoteModel: async (
    modelId,
    reason = 'Admin force-released checkout lock'
  ) => {
    try {
      const token = get().authToken;
      const summary = await api.forceReleaseRemoteModelLock(
        modelId,
        reason,
        token
      );
      const models = await api.listRemoteModels(token);
      const isCurrent = get().activeRemoteModel?.id === modelId;
      set({
        remoteModels: models,
        activeRemoteModel: isCurrent ? summary : get().activeRemoteModel,
        remoteWorkMode: isCurrent ? 'view_only' : get().remoteWorkMode,
        statusBanner: {
          type: 'info',
          message: `Force-released checkout lock on '${summary.name}'. The previous holder's direct check-in is now denied, and their draft is preserved for non-conflicting auto-reapply.`,
        },
      });
      return true;
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Admin force release failed';
      set({ statusBanner: { type: 'error', message: msg } });
      return false;
    }
  },

  reapplyRemoteModelChanges: async (modelId) => {
    const targetId = modelId || get().activeRemoteModel?.id;
    if (!targetId) return null;
    try {
      const { project, activeCheckoutId, activeRemoteModel, authToken } = get();
      const checkoutIdToUse =
        activeCheckoutId ||
        activeRemoteModel?.revoked_session?.checkout_id ||
        null;
      const res = await api.checkoutAndReapplyChanges(
        targetId,
        project,
        checkoutIdToUse,
        authToken
      );
      const models = await api.listRemoteModels(authToken);
      set({
        remoteModels: models,
        activeRemoteModel: res.summary,
        remoteWorkMode: 'checked_out_by_me',
        activeCheckoutId: res.active_checkout_id,
        project: res.project,
        lastMergeReport: res.merge_report,
        statusBanner: {
          type: 'success',
          message: res.message,
        },
      });
      await get().refreshCompiledCode();
      return res;
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Failed to re-apply non-conflicting changes';
      set({ statusBanner: { type: 'error', message: msg } });
      return null;
    }
  },

  clearMergeReport: () => set({ lastMergeReport: null }),
  setStatusBanner: (statusBanner) => set({ statusBanner }),
}));
