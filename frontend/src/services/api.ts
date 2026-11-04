import type {
  AgentExecutionResponse,
  CheckoutAndReapplyResponse,
  CompareDiffResult,
  CompileResponse,
  DatabaseConnection,
  DatabaseTestResult,
  DdlExecutionReport,
  EnterpriseDomain,
  EntityModel,
  FileInspectionSummary,
  LoginResponse,
  ModelAccessEntry,
  PreviewPushMetadataResponse,
  ProjectMetamodel,
  PushMetadataReport,
  RemoteModelDetailResponse,
  RemoteModelSummary,
  RevisionSummary,
  SheetInspectionResult,
  TargetDialect,
  UserDirectoryItem,
  UserProfile,
  UserRole,
} from '../types/metamodel';

// Connect directly to FastAPI backend on :8000 when running locally so browser requests
// never fail if Vite's dev proxy is restricted by local sandbox rules.
const API_BASE =
  typeof window !== 'undefined' &&
  (window.location.hostname === '127.0.0.1' ||
    window.location.hostname === 'localhost')
    ? 'http://127.0.0.1:8000/api'
    : '/api';

export async function request<T>(
  path: string,
  options: RequestInit = {},
  token?: string | null
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });
  } catch (netErr: unknown) {
    const errorMsg =
      netErr instanceof Error && netErr.name === 'TypeError'
        ? `Backend Network Error: Could not connect to MetaForge server at ${API_BASE}. (${netErr.message})`
        : String(netErr);
    throw new Error(errorMsg);
  }

  // Read body stream ONCE as text to avoid "Failed to execute 'text' on 'Response': body stream already read"
  const rawText = await res.text();

  if (!res.ok) {
    let errDetail = `HTTP ${res.status}`;
    if (rawText) {
      try {
        const parsed = JSON.parse(rawText);
        errDetail = parsed.detail || JSON.stringify(parsed);
      } catch {
        errDetail = rawText;
      }
    }
    throw new Error(errDetail);
  }

  if (!rawText) {
    return {} as T;
  }
  return JSON.parse(rawText) as T;
}

export const api = {
  login(email: string, password = 'password123'): Promise<LoginResponse> {
    return request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  getMe(token?: string | null): Promise<UserProfile> {
    return request<UserProfile>('/auth/me', { method: 'GET' }, token);
  },

  listUsers(token?: string | null): Promise<UserDirectoryItem[]> {
    return request<UserDirectoryItem[]>('/auth/users', { method: 'GET' }, token);
  },

  createUser(
    payload: {
      email: string;
      full_name: string;
      password: string;
      role: UserRole;
    },
    token?: string | null
  ): Promise<UserDirectoryItem> {
    return request<UserDirectoryItem>(
      '/auth/users',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      token
    );
  },

  updateUser(
    userId: number,
    payload: {
      full_name?: string;
      role?: UserRole;
      password?: string;
    },
    token?: string | null
  ): Promise<UserDirectoryItem> {
    return request<UserDirectoryItem>(
      `/auth/users/${userId}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token
    );
  },

  deleteUser(
    userId: number,
    token?: string | null
  ): Promise<{ status: string; email: string }> {
    return request<{ status: string; email: string }>(
      `/auth/users/${userId}`,
      { method: 'DELETE' },
      token
    );
  },

  getUserApiKeys(token?: string | null): Promise<{
    has_gemini_key: boolean;
    masked_gemini_key?: string | null;
    email: string;
    message: string;
  }> {
    return request('/user/keys', { method: 'GET' }, token);
  },

  saveUserApiKeys(
    geminiApiKey: string,
    token?: string | null
  ): Promise<{
    has_gemini_key: boolean;
    masked_gemini_key?: string | null;
    email: string;
    message: string;
  }> {
    return request(
      '/user/keys',
      {
        method: 'POST',
        body: JSON.stringify({ gemini_api_key: geminiApiKey }),
      },
      token
    );
  },

  deleteUserGeminiKey(
    token?: string | null
  ): Promise<{ status: string; email: string }> {
    return request('/user/keys/gemini', { method: 'DELETE' }, token);
  },

  getProject(token?: string | null): Promise<ProjectMetamodel> {
    return request<ProjectMetamodel>('/project', { method: 'GET' }, token);
  },

  saveProject(
    project: ProjectMetamodel,
    commitMessage = 'Saved model changes from ERD canvas',
    subjectArea = 'All',
    token?: string | null
  ): Promise<ProjectMetamodel> {
    return request<ProjectMetamodel>(
      '/project',
      {
        method: 'PUT',
        body: JSON.stringify({
          project,
          commit_message: commitMessage,
          subject_area: subjectArea,
        }),
      },
      token
    );
  },

  resetSeedProject(token?: string | null): Promise<ProjectMetamodel> {
    return request<ProjectMetamodel>(
      '/project/reset',
      { method: 'POST' },
      token
    );
  },

  compileProject(
    project: ProjectMetamodel,
    subjectArea?: string,
    token?: string | null
  ): Promise<CompileResponse> {
    return request<CompileResponse>(
      '/project/compile',
      {
        method: 'POST',
        body: JSON.stringify({
          project,
          subject_area: subjectArea === 'All' ? null : subjectArea,
        }),
      },
      token
    );
  },

  synthesizeViewSql(
    viewEntity: EntityModel,
    project: ProjectMetamodel,
    dialect: TargetDialect,
    token?: string | null
  ): Promise<{ select_sql: string; full_ddl: string }> {
    return request<{ select_sql: string; full_ddl: string }>(
      '/views/synthesize-sql',
      {
        method: 'POST',
        body: JSON.stringify({
          view_entity: viewEntity,
          project,
          dialect,
        }),
      },
      token
    );
  },

  applyNamingGlossary(
    project: ProjectMetamodel,
    token?: string | null
  ): Promise<ProjectMetamodel> {
    return request<ProjectMetamodel>(
      '/project/glossary/apply',
      {
        method: 'POST',
        body: JSON.stringify(project),
      },
      token
    );
  },

  cascadeDomain(
    domain: EnterpriseDomain,
    project: ProjectMetamodel,
    token?: string | null
  ): Promise<ProjectMetamodel> {
    return request<ProjectMetamodel>(
      '/project/domains/cascade',
      {
        method: 'POST',
        body: JSON.stringify({ domain, project }),
      },
      token
    );
  },

  reverseEngineerDdl(
    ddlScript: string,
    dialect: TargetDialect,
    subjectArea = 'Core',
    mergeIntoProject = true,
    token?: string | null
  ): Promise<{
    entities_parsed: number;
    relationships_parsed: number;
    project: ProjectMetamodel;
  }> {
    return request(
      '/reverse-engineer/ddl',
      {
        method: 'POST',
        body: JSON.stringify({
          ddl_script: ddlScript,
          dialect,
          subject_area: subjectArea,
          merge_into_project: mergeIntoProject,
        }),
      },
      token
    );
  },

  runCompleteCompare(
    currentProject: ProjectMetamodel,
    dialect: TargetDialect,
    targetDdl?: string,
    baselineRevisionId?: number,
    token?: string | null
  ): Promise<CompareDiffResult> {
    return request<CompareDiffResult>(
      '/compare/diff',
      {
        method: 'POST',
        body: JSON.stringify({
          current_project: currentProject,
          dialect,
          target_ddl: targetDdl || null,
          baseline_revision_id: baselineRevisionId ?? null,
        }),
      },
      token
    );
  },

  executeAgent(
    prompt: string,
    mode: 'kilo-cli' | 'builtin-llm' | 'gemini',
    project: ProjectMetamodel,
    geminiApiKey?: string | null,
    geminiModel?: string | null,
    token?: string | null
  ): Promise<AgentExecutionResponse> {
    return request<AgentExecutionResponse>(
      '/agent/execute',
      {
        method: 'POST',
        body: JSON.stringify({
          prompt,
          mode,
          project,
          gemini_api_key: geminiApiKey || null,
          gemini_model: geminiModel || 'gemini-2.5-flash',
        }),
      },
      token
    );
  },

  applyAgentMutations(
    mutations: any[],
    prompt: string,
    reply: string,
    modeUsed = 'Google Gemini (Client Direct)',
    project?: ProjectMetamodel | null,
    token?: string | null
  ): Promise<AgentExecutionResponse> {
    return request<AgentExecutionResponse>(
      '/agent/apply-mutations',
      {
        method: 'POST',
        body: JSON.stringify({
          mutations,
          prompt,
          reply,
          mode_used: modeUsed,
          project: project || null,
        }),
      },
      token
    );
  },

  getGeminiModels(token?: string | null): Promise<{
    models: { id: string; name: string; description: string; is_default: boolean }[];
  }> {
    return request('/agent/gemini-models', { method: 'GET' }, token);
  },


  listRevisions(token?: string | null): Promise<RevisionSummary[]> {
    return request<RevisionSummary[]>('/revisions', { method: 'GET' }, token);
  },

  restoreRevision(
    revisionId: number,
    token?: string | null
  ): Promise<ProjectMetamodel> {
    return request<ProjectMetamodel>(
      `/revisions/${revisionId}/restore`,
      { method: 'POST' },
      token
    );
  },

  autoGenerateMetadata(
    project: ProjectMetamodel,
    entityId?: string | null,
    overwriteExisting = true,
    geminiApiKey?: string | null,
    geminiModel?: string | null,
    token?: string | null
  ): Promise<{
    stats: {
      entities_updated: number;
      columns_updated: number;
      ai_provider?: string;
      model?: string;
      live_llm?: boolean;
      message?: string;
    };
    project: ProjectMetamodel;
  }> {
    const effectiveKey = geminiApiKey || null;
    const effectiveModel =
      geminiModel ||
      (typeof window !== 'undefined'
        ? localStorage.getItem('metaforge_gemini_model')
        : 'gemini-2.5-flash');
    return request(
      '/governance/auto-metadata',
      {
        method: 'POST',
        body: JSON.stringify({
          project,
          entity_id: entityId || null,
          overwrite_existing: overwriteExisting,
          gemini_api_key: effectiveKey || null,
          gemini_model: effectiveModel || 'gemini-2.5-flash',
          use_gemini: true,
        }),
      },
      token
    );
  },

  runDataProfiler(
    project: ProjectMetamodel,
    entityId?: string | null,
    token?: string | null
  ): Promise<{
    stats: {
      entities_profiled: number;
      columns_profiled: number;
      total_recommendations: number;
      profiled_at: string;
    };
    project: ProjectMetamodel;
  }> {
    return request(
      '/governance/profile',
      {
        method: 'POST',
        body: JSON.stringify({
          project,
          entity_id: entityId || null,
        }),
      },
      token
    );
  },

  applyRecommendedDq(
    project: ProjectMetamodel,
    entityId?: string | null,
    token?: string | null
  ): Promise<{
    stats: { rules_applied: number };
    project: ProjectMetamodel;
  }> {
    return request(
      '/governance/apply-dq',
      {
        method: 'POST',
        body: JSON.stringify({
          project,
          entity_id: entityId || null,
        }),
      },
      token
    );
  },

  applyModelingPattern(
    project: ProjectMetamodel,
    entityId: string,
    pattern: 'SCD_TYPE_2' | 'DATA_VAULT_HUB' | 'ENTERPRISE_AUDIT',
    token?: string | null
  ): Promise<{
    stats: { entity: string; pattern: string; columns_added: string[] };
    project: ProjectMetamodel;
  }> {
    return request(
      '/governance/apply-pattern',
      {
        method: 'POST',
        body: JSON.stringify({
          project,
          entity_id: entityId,
          pattern,
        }),
      },
      token
    );
  },

  // ---------------- Live Database Connections ----------------
  listConnections(token?: string | null): Promise<DatabaseConnection[]> {
    return request<DatabaseConnection[]>('/connections', { method: 'GET' }, token);
  },

  saveConnection(
    payload: Partial<DatabaseConnection> & { name: string; password_secret?: string | null },
    token?: string | null
  ): Promise<DatabaseConnection> {
    return request<DatabaseConnection>(
      '/connections',
      { method: 'POST', body: JSON.stringify(payload) },
      token
    );
  },

  deleteConnection(id: number, token?: string | null): Promise<{ deleted: boolean }> {
    return request(`/connections/${id}`, { method: 'DELETE' }, token);
  },

  testConnection(
    payload: Partial<DatabaseConnection> & { name: string; password_secret?: string | null },
    token?: string | null
  ): Promise<DatabaseTestResult> {
    return request<DatabaseTestResult>(
      '/connections/test',
      { method: 'POST', body: JSON.stringify(payload) },
      token
    );
  },

  reverseEngineerFromConnection(
    connectionId: number,
    project: ProjectMetamodel,
    subjectArea: string,
    selectedObjects: string[] | null,
    mergeIntoProject = true,
    token?: string | null
  ): Promise<{
    entities_parsed: number;
    relationships_parsed: number;
    extracted_ddl: string;
    connection_name: string;
    project: ProjectMetamodel;
  }> {
    return request(
      `/connections/${connectionId}/reverse-engineer`,
      {
        method: 'POST',
        body: JSON.stringify({
          project,
          subject_area: subjectArea,
          selected_objects: selectedObjects && selectedObjects.length ? selectedObjects : null,
          merge_into_project: mergeIntoProject,
        }),
      },
      token
    );
  },

  profileFromConnection(
    connectionId: number,
    project: ProjectMetamodel,
    entityId?: string | null,
    token?: string | null
  ): Promise<{
    stats: {
      entities_profiled: number;
      live_tables_profiled: number;
      columns_profiled: number;
      total_recommendations: number;
      connection_name: string;
      profiled_at: string;
    };
    project: ProjectMetamodel;
  }> {
    return request(
      `/connections/${connectionId}/profile`,
      {
        method: 'POST',
        body: JSON.stringify({ project, entity_id: entityId || null }),
      },
      token
    );
  },

  executeDdlOnConnection(
    connectionId: number,
    ddlScript: string,
    dryRun: boolean,
    token?: string | null
  ): Promise<DdlExecutionReport> {
    return request<DdlExecutionReport>(
      `/connections/${connectionId}/execute-ddl`,
      {
        method: 'POST',
        body: JSON.stringify({ ddl_script: ddlScript, dry_run: dryRun }),
      },
      token
    );
  },

  async uploadFileForInspection(
    file: File,
    token?: string | null
  ): Promise<FileInspectionSummary> {
    const formData = new FormData();
    formData.append('file', file);
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${API_BASE}/reverse-engineer/file`, {
      method: 'POST',
      headers,
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `Upload failed with status ${res.status}`);
    }
    return res.json();
  },

  commitFileImport(
    sheets: SheetInspectionResult[],
    subjectArea = 'Staging',
    mergeIntoProject = true,
    token?: string | null
  ): Promise<{
    ok: boolean;
    entities_imported: number;
    relationships_inferred: number;
    target_subject_area: string;
    project: ProjectMetamodel;
  }> {
    return request(
      '/reverse-engineer/file/commit',
      {
        method: 'POST',
        body: JSON.stringify({
          sheets,
          subject_area: subjectArea,
          merge_into_project: mergeIntoProject,
        }),
      },
      token
    );
  },

  generateDefinitionsFromProfile(
    entityId?: string | null,
    overwriteExisting = true,
    geminiApiKey?: string | null,
    geminiModel?: string | null,
    token?: string | null
  ): Promise<{
    ok: boolean;
    entities_updated: number;
    columns_updated: number;
    ai_provider?: string;
    live_llm?: boolean;
    message?: string;
    project: ProjectMetamodel;
  }> {
    const effectiveKey = geminiApiKey || null;
    const effectiveModel =
      geminiModel ||
      (typeof window !== 'undefined'
        ? localStorage.getItem('metaforge_gemini_model')
        : 'gemini-2.5-flash');
    return request(
      '/governance/generate-definitions-from-profile',
      {
        method: 'POST',
        body: JSON.stringify({
          entity_id: entityId || null,
          overwrite_existing: overwriteExisting,
          gemini_api_key: effectiveKey || null,
          gemini_model: effectiveModel || 'gemini-2.5-flash',
          use_gemini: true,
        }),
      },
      token
    );
  },

  previewPushMetadata(
    connectionId: number,
    token?: string | null
  ): Promise<PreviewPushMetadataResponse> {
    return request<PreviewPushMetadataResponse>(
      `/connections/${connectionId}/preview-push-metadata`,
      { method: 'GET' },
      token
    );
  },

  pushMetadataToDatabase(
    connectionId: number,
    dryRun: boolean,
    entityIds?: string[] | null,
    token?: string | null
  ): Promise<PushMetadataReport> {
    return request<PushMetadataReport>(
      `/connections/${connectionId}/push-metadata`,
      {
        method: 'POST',
        body: JSON.stringify({
          dry_run: dryRun,
          entity_ids: entityIds && entityIds.length ? entityIds : null,
        }),
      },
      token
    );
  },

  async downloadDataDictionaryCsv(token?: string | null): Promise<Blob> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/export/data-dictionary/csv`, {
      method: 'GET',
      headers,
    });
    if (!res.ok) {
      throw new Error(`Data dictionary export failed with status ${res.status}`);
    }
    return res.blob();
  },

  getMcpConfig(token?: string | null): Promise<any> {
    return request('/mcp/config', { method: 'GET' }, token);
  },

  getMcpTools(token?: string | null): Promise<{ tools: any[]; count: number }> {
    return request('/mcp/tools', { method: 'GET' }, token);
  },

  callMcpTool(name: string, args: Record<string, any> = {}, token?: string | null): Promise<any> {
    return request(
      '/mcp/call',
      {
        method: 'POST',
        body: JSON.stringify({ name, arguments: args }),
      },
      token
    );
  },

  // ---------------------------------------------------------------------------
  // Remote Model Repository, User Access Control, Check-Out Locking & 3-Way Reapply
  // ---------------------------------------------------------------------------
  listRemoteModels(token?: string | null): Promise<RemoteModelSummary[]> {
    return request<RemoteModelSummary[]>('/remote-models', { method: 'GET' }, token);
  },

  createRemoteModel(
    name: string,
    description: string,
    project?: ProjectMetamodel | null,
    token?: string | null
  ): Promise<RemoteModelSummary> {
    return request<RemoteModelSummary>(
      '/remote-models',
      {
        method: 'POST',
        body: JSON.stringify({ name, description, project: project || null }),
      },
      token
    );
  },

  viewRemoteModel(
    modelId: string,
    token?: string | null
  ): Promise<RemoteModelDetailResponse> {
    return request<RemoteModelDetailResponse>(
      `/remote-models/${encodeURIComponent(modelId)}/view`,
      { method: 'GET' },
      token
    );
  },

  checkoutRemoteModel(
    modelId: string,
    token?: string | null
  ): Promise<RemoteModelDetailResponse> {
    return request<RemoteModelDetailResponse>(
      `/remote-models/${encodeURIComponent(modelId)}/checkout`,
      { method: 'POST', body: JSON.stringify({}) },
      token
    );
  },

  saveRemoteDraft(
    modelId: string,
    project: ProjectMetamodel,
    checkoutId?: string | null,
    token?: string | null
  ): Promise<{ status: string; session_status: string; checkout_id?: string | null }> {
    return request(
      `/remote-models/${encodeURIComponent(modelId)}/draft`,
      {
        method: 'POST',
        body: JSON.stringify({ project, checkout_id: checkoutId || null }),
      },
      token
    );
  },

  checkinRemoteModel(
    modelId: string,
    project: ProjectMetamodel,
    commitMessage = 'Checked in model changes to shared repository',
    checkoutId?: string | null,
    token?: string | null
  ): Promise<RemoteModelDetailResponse> {
    return request<RemoteModelDetailResponse>(
      `/remote-models/${encodeURIComponent(modelId)}/checkin`,
      {
        method: 'POST',
        body: JSON.stringify({
          project,
          commit_message: commitMessage,
          checkout_id: checkoutId || null,
        }),
      },
      token
    );
  },

  releaseRemoteModelLock(
    modelId: string,
    token?: string | null
  ): Promise<RemoteModelDetailResponse> {
    return request<RemoteModelDetailResponse>(
      `/remote-models/${encodeURIComponent(modelId)}/release`,
      { method: 'POST', body: JSON.stringify({}) },
      token
    );
  },

  forceReleaseRemoteModelLock(
    modelId: string,
    reason = 'Admin force-released checkout lock',
    token?: string | null
  ): Promise<RemoteModelSummary> {
    return request<RemoteModelSummary>(
      `/remote-models/${encodeURIComponent(modelId)}/force-release`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      },
      token
    );
  },

  checkoutAndReapplyChanges(
    modelId: string,
    project?: ProjectMetamodel | null,
    checkoutId?: string | null,
    token?: string | null
  ): Promise<CheckoutAndReapplyResponse> {
    return request<CheckoutAndReapplyResponse>(
      `/remote-models/${encodeURIComponent(modelId)}/reapply`,
      {
        method: 'POST',
        body: JSON.stringify({
          project: project || null,
          checkout_id: checkoutId || null,
        }),
      },
      token
    );
  },

  getRemoteModelAccess(
    modelId: string,
    token?: string | null
  ): Promise<ModelAccessEntry[]> {
    return request<ModelAccessEntry[]>(
      `/remote-models/${encodeURIComponent(modelId)}/access`,
      { method: 'GET' },
      token
    );
  },

  updateRemoteModelAccess(
    modelId: string,
    entries: ModelAccessEntry[],
    token?: string | null
  ): Promise<ModelAccessEntry[]> {
    return request<ModelAccessEntry[]>(
      `/remote-models/${encodeURIComponent(modelId)}/access`,
      {
        method: 'PUT',
        body: JSON.stringify({ entries }),
      },
      token
    );
  },
};


