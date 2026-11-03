import { request } from './api';
import type { ProjectMetamodel } from '../types/metamodel';

export interface AIProviderInfo {
  name: string;
  label: string;
  kind: 'offline' | 'cli' | 'api';
  fields: string[];
  defaults: Record<string, unknown>;
  config: Record<string, unknown>;
  available: boolean;
}

export interface AIProvidersResponse {
  active_provider: string;
  privacy: { metadata_only: boolean; audit_ai_calls: boolean };
  providers: AIProviderInfo[];
}

export interface SpecColumn {
  name: string;
  type: string;
  pk?: boolean;
  fk?: boolean;
  nullable?: boolean;
  unique?: boolean;
  description?: string;
}
export interface SpecTable {
  name: string;
  logical_name?: string;
  description?: string;
  subject_area?: string;
  columns: SpecColumn[];
}
export interface ModelSpec {
  summary?: string;
  source?: string;
  warnings?: string[];
  detected_formats?: string[];
  tables: SpecTable[];
  relationships: {
    name?: string;
    parent: string;
    parent_column?: string;
    child: string;
    child_column?: string;
    cardinality?: string;
    description?: string;
  }[];
}
export interface SpecDiff {
  new_tables: string[];
  extended_tables: { table: string; new_columns: string[] }[];
  relationships: number;
}

export interface SearchResult {
  kind: 'entity' | 'column' | 'relationship';
  entity_id?: string;
  column_id?: string;
  relationship_id?: string;
  title: string;
  subtitle: string;
  detail?: string;
  score: number;
  reason: string;
}

export interface DocProposal {
  target: 'entity' | 'column' | 'relationship';
  entity_id?: string;
  column_id?: string;
  relationship_id?: string;
  label: string;
  current: string;
  proposed: string;
}

export interface ContextDoc {
  id: string;
  title: string;
  filename: string;
  kind: string;
  chars: number;
  preview?: string;
  include: boolean;
  added_at: string;
}

export interface ChatResponse {
  mode_used: string;
  reply: string;
  mutated: boolean;
  actions_taken: string[];
  mutations: Record<string, unknown>[];
  updated_model: ProjectMetamodel;
  warnings: string[];
}

export interface EditorApplyResponse {
  ok: boolean;
  errors: { line: number; message: string }[];
  changes: string[];
  project?: ProjectMetamodel;
}

type Tok = string | null | undefined;
const post = <T>(path: string, body: unknown, token: Tok) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) }, token);

export const aiApi = {
  providers: (token: Tok) => request<AIProvidersResponse>('/ai/providers', {}, token),
  saveSettings: (body: Record<string, unknown>, token: Tok) =>
    request<Record<string, unknown>>('/ai/settings', { method: 'PUT', body: JSON.stringify(body) }, token),
  testProvider: (name: string, config: Record<string, unknown>, token: Tok) =>
    post<{ ok: boolean; output: string }>(`/ai/providers/${name}/test`, { provider_config: config }, token),
  privacy: (token: Tok) =>
    request<{
      settings: { metadata_only: boolean; audit_ai_calls: boolean };
      never_sent: string[];
      sent: string[];
      audit: { ts: string; feature: string; provider: string; payload_chars: number; ok: boolean }[];
    }>('/ai/privacy', {}, token),
  privacyPreview: (project: ProjectMetamodel, token: Tok) =>
    post<{ catalog: unknown; chars: number }>('/ai/privacy/preview', { project }, token),
  scrub: (project: ProjectMetamodel, token: Tok) =>
    post<{ project: ProjectMetamodel; cleared: number }>('/ai/privacy/scrub', { project }, token),
  listContext: (token: Tok) => request<ContextDoc[]>('/ai/context', {}, token),
  addContextText: (title: string, text: string, token: Tok) =>
    post<ContextDoc>('/ai/context/text', { title, text }, token),
  uploadContext: async (file: File, token: Tok): Promise<ContextDoc> => {
    const fd = new FormData();
    fd.append('file', file);
    const base =
      typeof window !== 'undefined' &&
      (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost')
        ? 'http://127.0.0.1:8000/api'
        : '/api';
    const res = await fetch(`${base}/ai/context/upload`, {
      method: 'POST',
      body: fd,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const txt = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = JSON.parse(txt).detail || msg;
      } catch {
        /* keep status */
      }
      throw new Error(msg);
    }
    return JSON.parse(txt);
  },
  patchContext: (id: string, patch: Partial<ContextDoc>, token: Tok) =>
    request<ContextDoc>(`/ai/context/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }, token),
  deleteContext: (id: string, token: Tok) =>
    request<{ deleted: boolean }>(`/ai/context/${id}`, { method: 'DELETE' }, token),
  generate: (
    body: { project: ProjectMetamodel; text: string; use_library: boolean; subject_area: string; instructions: string; provider?: string },
    token: Tok
  ) => post<{ spec: ModelSpec; diff: SpecDiff }>('/ai/generate', body, token),
  applySpec: (project: ProjectMetamodel, spec: ModelSpec, token: Tok) =>
    post<{ project: ProjectMetamodel; actions: string[] }>('/ai/generate/apply', { project, spec }, token),
  search: (project: ProjectMetamodel, query: string, useAi: boolean, provider: string | undefined, token: Tok) =>
    post<{ answer: string; results: SearchResult[]; source: string; warnings?: string[] }>(
      '/ai/search',
      { project, query, use_ai: useAi, provider },
      token
    ),
  document: (project: ProjectMetamodel, entityIds: string[] | null, onlyMissing: boolean, provider: string | undefined, token: Tok) =>
    post<{ proposals: DocProposal[]; source: string; warnings: string[] }>(
      '/ai/document',
      { project, entity_ids: entityIds, only_missing: onlyMissing, provider },
      token
    ),
  applyDocs: (project: ProjectMetamodel, proposals: DocProposal[], token: Tok) =>
    post<{ project: ProjectMetamodel; applied: number }>('/ai/document/apply', { project, proposals }, token),
  explain: (
    project: ProjectMetamodel,
    target: { entity_id?: string | null; column_id?: string | null; relationship_id?: string | null },
    provider: string | undefined,
    token: Tok
  ) => post<{ markdown: string; source: string; warnings?: string[] }>('/ai/explain', { project, provider, ...target }, token),
  chat: (
    project: ProjectMetamodel,
    prompt: string,
    history: { role: string; content: string }[],
    provider: string | undefined,
    token: Tok
  ) => post<ChatResponse>('/ai/chat', { project, prompt, history, provider }, token),
  editorRender: (project: ProjectMetamodel, dialect: string, token: Tok) =>
    post<{ text: string }>('/ai/editor/render', { project, dialect }, token),
  editorApply: (project: ProjectMetamodel, text: string, dialect: string, token: Tok) =>
    post<EditorApplyResponse>('/ai/editor/apply', { project, text, dialect }, token),
};
