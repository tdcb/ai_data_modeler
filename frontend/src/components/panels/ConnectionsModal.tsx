import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Database,
  Plug,
  Trash2,
  Plus,
  X,
  CheckCircle2,
  XCircle,
  Download,
  BarChart3,
  Play,
  Loader2,
  FileSpreadsheet,
  Send,
  Sparkles,
  FileText,
  Layers,
  ArrowRight,
  Check,
} from 'lucide-react';
import { useModelStore } from '../../store/useModelStore';
import { api } from '../../services/api';
import type {
  DatabaseConnection,
  DatabaseTestResult,
  DdlExecutionReport,
  FileInspectionSummary,
  PreviewPushMetadataResponse,
  PushMetadataReport,
  SheetInspectionResult,
} from '../../types/metamodel';

type Tab = 'connections' | 'reverse' | 'files' | 'profile' | 'metadata_push' | 'ddl';

interface ConnForm {
  id?: number;
  name: string;
  dialect: string;
  host: string;
  port: string;
  database_name: string;
  schema_name: string;
  username: string;
  password_secret: string;
  warehouse: string;
  role_name: string;
  connection_url: string;
  is_default: boolean;
}

const EMPTY_FORM: ConnForm = {
  name: '',
  dialect: 'snowflake',
  host: '',
  port: '',
  database_name: '',
  schema_name: 'PUBLIC',
  username: '',
  password_secret: '',
  warehouse: '',
  role_name: '',
  connection_url: '',
  is_default: false,
};

const DIALECT_LABELS: Record<string, string> = {
  sqlite: 'SQLite (Multi-Zone Local File)',
  snowflake: 'Snowflake Data Cloud',
  sql_server: 'Microsoft SQL Server (T-SQL)',
  oracle: 'Oracle Database',
  postgresql: 'PostgreSQL',
};

/** Open from anywhere via: window.dispatchEvent(new CustomEvent('metaforge:open-connections', { detail: { tab } })) */
export const ConnectionsModal: React.FC = () => {
  const project = useModelStore((s) => s.project);
  const authToken = useModelStore((s) => s.authToken);
  const currentUser = useModelStore((s) => s.currentUser);
  const selectedEntityId = useModelStore((s) => s.selectedEntityId);
  const setProject = useModelStore((s) => s.setProject);
  const refreshCompiledCode = useModelStore((s) => s.refreshCompiledCode);
  const setStatusBanner = useModelStore((s) => s.setStatusBanner);

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('connections');
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [form, setForm] = useState<ConnForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<DatabaseTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reverse engineering state
  const [discovered, setDiscovered] = useState<DatabaseTestResult | null>(null);
  const [selectedObjects, setSelectedObjects] = useState<string[]>([]);
  const [subjectArea, setSubjectArea] = useState('Core');
  const [mergeIntoProject, setMergeIntoProject] = useState(true);
  const [extractedDdl, setExtractedDdl] = useState('');

  // Excel / CSV File state
  const [fileInspection, setFileInspection] = useState<FileInspectionSummary | null>(null);
  const [selectedSheets, setSelectedSheets] = useState<string[]>([]);
  const [fileSubjectArea, setFileSubjectArea] = useState('Staging');
  const [fileMerge, setFileMerge] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [filePreviewSheet, setFilePreviewSheet] = useState<SheetInspectionResult | null>(null);

  // Profiling state
  const [profileScope, setProfileScope] = useState<'selected' | 'all'>('all');
  const [profileSummary, setProfileSummary] = useState<string>('');
  const [isGeneratingDefs, setIsGeneratingDefs] = useState(false);
  const [genDefSummary, setGenDefSummary] = useState<string>('');

  // Metadata Pushback state
  const [pushPreview, setPushPreview] = useState<PreviewPushMetadataResponse | null>(null);
  const [pushDryRun, setPushDryRun] = useState(true);
  const [pushReport, setPushReport] = useState<PushMetadataReport | null>(null);

  // DDL execution state
  const [ddlSource, setDdlSource] = useState<'snowflake' | 'sql_server' | 'oracle' | 'custom'>('snowflake');
  const [ddlScript, setDdlScript] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [ddlReport, setDdlReport] = useState<DdlExecutionReport | null>(null);

  const canEdit = currentUser.role === 'Admin' || currentUser.role === 'Data Architect';
  const activeConn = useMemo(
    () => connections.find((c) => c.id === activeId) || null,
    [connections, activeId]
  );

  const loadConnections = useCallback(async () => {
    try {
      const rows = await api.listConnections(authToken);
      setConnections(rows);
      setActiveId((prev) => prev ?? rows.find((r) => r.is_default)?.id ?? rows[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [authToken]);

  useEffect(() => {
    const handler = (ev: Event) => {
      const custom = ev as CustomEvent<{ tab?: Tab }>;
      if (custom.detail?.tab) setTab(custom.detail.tab);
      setOpen(true);
      setError(null);
      void loadConnections();
    };
    window.addEventListener('metaforge:open-connections', handler);
    return () => window.removeEventListener('metaforge:open-connections', handler);
  }, [loadConnections]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const formToPayload = (f: ConnForm) => ({
    id: f.id,
    name: f.name.trim(),
    dialect: f.dialect,
    host: f.host.trim() || null,
    port: f.port ? Number(f.port) : null,
    database_name: f.database_name.trim() || null,
    schema_name: f.schema_name.trim() || null,
    username: f.username.trim() || null,
    password_secret: f.password_secret ? f.password_secret : null,
    warehouse: f.warehouse.trim() || null,
    role_name: f.role_name.trim() || null,
    connection_url: f.connection_url.trim() || null,
    is_default: f.is_default,
  });

  const editConnection = (c: DatabaseConnection) => {
    setTestResult(null);
    setForm({
      id: c.id,
      name: c.name,
      dialect: c.dialect,
      host: c.host || '',
      port: c.port ? String(c.port) : '',
      database_name: c.database_name || '',
      schema_name: c.schema_name || '',
      username: c.username || '',
      password_secret: '',
      warehouse: c.warehouse || '',
      role_name: c.role_name || '',
      connection_url: c.connection_url || '',
      is_default: c.is_default,
    });
  };

  const hasDiscoveredConnIdRef = useRef<number | null>(null);

  const discover = () =>
    run(async () => {
      if (!activeConn) return;
      hasDiscoveredConnIdRef.current = activeConn.id;
      const res = await api.testConnection({ id: activeConn.id, name: activeConn.name }, authToken);
      setDiscovered(res);
      if (!res.ok) {
        setError(res.message);
      } else {
        const tbls = Array.isArray(res.tables) ? res.tables : [];
        const vws = Array.isArray(res.views) ? res.views : [];
        setSelectedObjects([...tbls, ...vws]);
      }
    });

  useEffect(() => {
    if (open && tab === 'reverse' && activeConn && activeConn.id !== hasDiscoveredConnIdRef.current) {
      void discover();
    }
  }, [open, tab, activeConn?.id]);

  // Categorize discovered objects into zones
  const categorizedObjects = useMemo(() => {
    const staging: string[] = [];
    const core: string[] = [];
    const consumption: string[] = [];
    if (!discovered?.ok) return { staging, core, consumption };

    const rawTables = Array.isArray(discovered.tables) ? discovered.tables : [];
    const rawViews = Array.isArray(discovered.views) ? discovered.views : [];
    const all = [
      ...rawTables.map((t) => ({ name: t, type: 'TABLE' })),
      ...rawViews.map((v) => ({ name: v, type: 'VIEW' })),
    ];
    for (const obj of all) {
      const up = (obj.name || '').toUpperCase();
      if (up.startsWith('STG_') || up.startsWith('RAW_')) {
        staging.push(obj.name);
      } else if (up.startsWith('MART_') || up.startsWith('VW_') || obj.type === 'VIEW') {
        consumption.push(obj.name);
      } else {
        core.push(obj.name);
      }
    }
    return { staging, core, consumption };
  }, [discovered]);

  const ConnectionPicker = (
    <div className="flex items-center gap-2 mb-3 bg-slate-950 p-2 rounded-xl border border-slate-800">
      <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold shrink-0">
        Active Database:
      </span>
      <select
        value={activeId ?? ''}
        onChange={(e) => {
          setActiveId(Number(e.target.value));
          setDiscovered(null);
        }}
        className="bg-transparent text-xs font-semibold text-sky-400 outline-none cursor-pointer flex-1"
      >
        {connections.map((c) => (
          <option key={c.id} value={c.id} className="bg-slate-900 text-slate-100">
            {c.name} — {DIALECT_LABELS[c.dialect] || c.dialect} {c.is_default ? '(Default)' : ''}
          </option>
        ))}
      </select>
    </div>
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="w-[1040px] max-w-full h-[86vh] bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between bg-slate-950/80">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-sky-400" />
            <h2 className="text-sm font-bold text-white">Database Connections & Data Ingestion</h2>
            <span className="px-2 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 font-mono">
              Multi-Zone • Excel • CSV • Profiling • Pushback
            </span>
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400 ml-1" />}
          </div>
          <button type="button" onClick={() => setOpen(false)} className="text-slate-400 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs Bar */}
        <div className="px-5 pt-2 flex gap-1 border-b border-slate-800 bg-slate-950/40">
          {(
            [
              { id: 'connections', label: 'Connections', icon: Plug },
              { id: 'reverse', label: 'Reverse Engineer', icon: Download },
              { id: 'files', label: 'Excel / CSV Ingest', icon: FileSpreadsheet },
              { id: 'profile', label: 'Data Profiling & Definitions', icon: BarChart3 },
              { id: 'metadata_push', label: 'Push to Database', icon: Send },
              { id: 'ddl', label: 'Apply DDL', icon: Play },
            ] as { id: Tab; label: string; icon: React.ElementType }[]
          ).map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-all ${
                  active
                    ? 'border-blue-500 text-white bg-slate-800/80 shadow'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${active ? 'text-blue-400' : 'text-slate-500'}`} />
                {t.label}
              </button>
            );
          })}
        </div>

        {error && (
          <div className="mx-5 mt-3 px-3.5 py-2 rounded-xl bg-rose-950/80 border border-rose-700 text-rose-200 text-xs break-all flex items-center justify-between">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} className="text-rose-400 hover:text-white">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-auto p-5">
          {/* ===================================================================
              1. Connections Management Tab
              =================================================================== */}
          {tab === 'connections' && (
            <div className="grid grid-cols-[300px_1fr] gap-5 h-full">
              <div className="flex flex-col gap-2">
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => {
                      setTestResult(null);
                      setForm({ ...EMPTY_FORM });
                    }}
                    className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-md transition-all"
                  >
                    <Plus className="w-3.5 h-3.5" /> New Database Connection
                  </button>
                )}
                {connections.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => {
                      setActiveId(c.id);
                      editConnection(c);
                    }}
                    className={`p-3 rounded-xl border cursor-pointer transition-all ${
                      activeId === c.id
                        ? 'border-blue-500 bg-blue-950/30 ring-1 ring-blue-500/50'
                        : 'border-slate-800 bg-slate-950/60 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-100 truncate">{c.name}</span>
                      {canEdit && (
                        <button
                          type="button"
                          title="Delete connection"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!window.confirm(`Delete connection "${c.name}"?`)) return;
                            run(async () => {
                              await api.deleteConnection(c.id, authToken);
                              if (activeId === c.id) setActiveId(null);
                              setForm(null);
                              await loadConnections();
                            });
                          }}
                          className="text-slate-500 hover:text-rose-400 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="text-[10px] text-slate-400 mt-1 flex items-center justify-between">
                      <span className="capitalize">{c.dialect}</span>
                      {c.is_default && (
                        <span className="px-1.5 py-0.2 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 font-bold">
                          Default Live DB
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-1 mt-2 pt-2 border-t border-slate-800/80">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveId(c.id);
                          setDiscovered(null);
                          setTab('reverse');
                        }}
                        className="flex items-center gap-1 text-[10px] font-bold text-emerald-400 hover:text-emerald-300 transition-colors"
                      >
                        <Download className="w-3 h-3" />
                        <span>Reverse Eng &raquo;</span>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveId(c.id);
                          setTab('profile');
                        }}
                        className="flex items-center gap-1 text-[10px] font-bold text-sky-400 hover:text-sky-300 transition-colors"
                      >
                        <BarChart3 className="w-3 h-3" />
                        <span>Profile &raquo;</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Form & Test Card */}
              <div className="border border-slate-800 bg-slate-950/60 rounded-xl p-4 overflow-auto">
                {form ? (
                  <div className="space-y-3">
                    <h3 className="text-xs font-bold text-slate-200">
                      {form.id ? `Edit: ${form.name}` : 'New Database Connection'}
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="flex flex-col gap-1 col-span-2">
                        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Name</span>
                        <input
                          value={form.name}
                          onChange={(e) => setForm({ ...form, name: e.target.value })}
                          className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 outline-none focus:border-blue-500"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Dialect</span>
                        <select
                          value={form.dialect}
                          onChange={(e) => setForm({ ...form, dialect: e.target.value })}
                          className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-100"
                        >
                          {Object.entries(DIALECT_LABELS).map(([k, label]) => (
                            <option key={k} value={k}>{label}</option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Database / File</span>
                        <input
                          value={form.database_name}
                          onChange={(e) => setForm({ ...form, database_name: e.target.value })}
                          placeholder={form.dialect === 'sqlite' ? 'workspace_model/demo_warehouse.db' : 'DB_NAME'}
                          className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 outline-none focus:border-blue-500"
                        />
                      </label>
                      {form.dialect !== 'sqlite' && (
                        <>
                          <label className="flex flex-col gap-1">
                            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Host</span>
                            <input
                              value={form.host}
                              onChange={(e) => setForm({ ...form, host: e.target.value })}
                              className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Port</span>
                            <input
                              value={form.port}
                              onChange={(e) => setForm({ ...form, port: e.target.value })}
                              className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Username</span>
                            <input
                              value={form.username}
                              onChange={(e) => setForm({ ...form, username: e.target.value })}
                              className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Password</span>
                            <input
                              type="password"
                              value={form.password_secret}
                              onChange={(e) => setForm({ ...form, password_secret: e.target.value })}
                              placeholder={form.id ? '•••••••• (leave blank to keep existing)' : ''}
                              className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                            />
                          </label>
                        </>
                      )}
                    </div>

                    <div className="flex items-center gap-2 pt-2">
                      <button
                        type="button"
                        onClick={() =>
                          run(async () => {
                            const res = await api.testConnection(formToPayload(form), authToken);
                            setTestResult(res);
                            if (!res.ok) setError(res.message);
                          })
                        }
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs text-slate-100"
                      >
                        <Plug className="w-3.5 h-3.5" /> Test Connection
                      </button>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() =>
                            run(async () => {
                              const saved = await api.saveConnection(formToPayload(form), authToken);
                              await loadConnections();
                              setActiveId(saved.id);
                              editConnection(saved);
                              setStatusBanner({ type: 'success', message: `Saved connection "${saved.name}"` });
                            })
                          }
                          className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs text-white font-semibold"
                        >
                          Save Connection
                        </button>
                      )}
                      {form.id && (
                        <button
                          type="button"
                          onClick={() => {
                            setActiveId(form.id!);
                            setDiscovered(null);
                            setTab('reverse');
                          }}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/30 hover:bg-emerald-600/40 border border-emerald-500/50 text-xs text-emerald-300 font-semibold"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Reverse Engineer Tables &raquo;</span>
                        </button>
                      )}
                    </div>

                    {testResult && (
                      <div
                        className={`p-3 rounded-xl border text-xs ${
                          testResult.ok ? 'bg-emerald-950/40 border-emerald-700 text-emerald-200' : 'bg-rose-950/40 border-rose-700 text-rose-200'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 font-semibold mb-1">
                          {testResult.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <XCircle className="w-3.5 h-3.5 text-rose-400" />}
                          {testResult.message}
                        </div>
                        {testResult.ok && (
                          <div className="text-[11px] text-slate-300 mt-1">
                            Discovered {testResult.tables.length} tables and {testResult.views.length} views.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center text-xs text-slate-500">
                    Select a connection on the left or create a new one.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ===================================================================
              2. Reverse Engineering Tab (Multi-Zone SQLite / Snowflake / SQL Server)
              =================================================================== */}
          {tab === 'reverse' && (
            <div className="flex flex-col gap-3">
              {ConnectionPicker}

              {/* SQLite & Multi-Zone Database Quick Status Banner */}
              {activeConn && (
                <div className="p-3 bg-gradient-to-r from-emerald-950/60 via-slate-900 to-slate-950 border border-emerald-500/40 rounded-xl flex items-center justify-between gap-4 shadow-lg">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center shrink-0">
                      <Database className="w-4 h-4 text-emerald-400" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-slate-100 flex items-center gap-2">
                        <span>Database: {activeConn.name}</span>
                        <span className="px-1.5 py-0.2 rounded text-[9px] bg-emerald-500/20 text-emerald-300 font-mono border border-emerald-500/30">
                          {(activeConn.dialect || '').toUpperCase()} LIVE
                        </span>
                        {activeConn.dialect === 'sqlite' && (
                          <span className="px-1.5 py-0.2 rounded text-[9px] bg-sky-500/20 text-sky-300 font-mono">
                            STAGING • CORE • CONSUMPTION
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400 truncate">
                        {discovered?.ok
                          ? `Discovered ${(discovered.tables || []).length} table(s) and ${(discovered.views || []).length} view(s). Automatically routed to Staging, Core DWH, and Consumption layers.`
                          : 'Auto-discovering tables, views, primary keys, and data distributions...'}
                      </p>
                    </div>
                  </div>
                  {discovered?.ok && (
                    <button
                      type="button"
                      disabled={busy || !canEdit || selectedObjects.length === 0}
                      onClick={() =>
                        run(async () => {
                          if (!activeConn) return;
                          const res = await api.reverseEngineerFromConnection(
                            activeConn.id,
                            project,
                            subjectArea || 'Core',
                            selectedObjects,
                            mergeIntoProject,
                            authToken
                          );
                          setExtractedDdl(res.extracted_ddl);
                          setProject(res.project, true);
                          await refreshCompiledCode();
                          setStatusBanner({
                            type: 'success',
                            message: `Imported ${res.entities_parsed} object(s) across Staging, Core, and Consumption zones into canvas!`,
                          });
                          setTimeout(() => {
                            window.dispatchEvent(new CustomEvent('metaforge:auto-layout'));
                          }, 200);
                        })
                      }
                      className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs text-white font-bold shrink-0 shadow-md transition-all cursor-pointer disabled:opacity-40"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Reverse Engineer {selectedObjects.length} Object(s) to Canvas</span>
                    </button>
                  )}
                </div>
              )}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={busy || !activeConn}
                  onClick={discover}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs text-slate-100 font-semibold"
                >
                  <Plug className="w-3.5 h-3.5 text-sky-400" /> 1. Discover Multi-Zone Objects
                </button>
                <label className="flex items-center gap-1.5 text-xs text-slate-300">
                  Default Subject Area:
                  <input
                    value={subjectArea}
                    onChange={(e) => setSubjectArea(e.target.value)}
                    list="mf-subject-areas"
                    className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs w-36"
                  />
                  <datalist id="mf-subject-areas">
                    {project.subject_areas.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </label>
                <label className="flex items-center gap-1.5 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={mergeIntoProject}
                    onChange={(e) => setMergeIntoProject(e.target.checked)}
                  />
                  Merge into current model (uncheck to replace)
                </label>
              </div>

              {discovered?.ok && (
                <div className="border border-slate-800 rounded-xl p-3.5 bg-slate-950 space-y-3">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                    <div>
                      <span className="text-xs font-bold text-slate-100">
                        Select Objects to Reverse Engineer ({selectedObjects.length} selected)
                      </span>
                      <p className="text-[10px] text-slate-400">
                        Objects will be automatically routed to their Subject Areas (Staging, Core, Consumption) with dedicated color badges.
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs">
                      <button
                        type="button"
                        onClick={() => setSelectedObjects([...(discovered?.tables || []), ...(discovered?.views || [])])}
                        className="px-2 py-0.5 rounded bg-slate-800 text-sky-300 hover:bg-slate-700"
                      >
                        All
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedObjects(categorizedObjects.staging)}
                        className="px-2 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800/40 hover:bg-amber-900/60"
                      >
                        Staging Only
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedObjects(categorizedObjects.core)}
                        className="px-2 py-0.5 rounded bg-blue-950/60 text-blue-300 border border-blue-800/40 hover:bg-blue-900/60"
                      >
                        Core DWH Only
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedObjects(categorizedObjects.consumption)}
                        className="px-2 py-0.5 rounded bg-teal-950/60 text-teal-300 border border-teal-800/40 hover:bg-teal-900/60"
                      >
                        Consumption Only
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedObjects([])}
                        className="px-2 py-0.5 rounded bg-slate-800 text-slate-400 hover:bg-slate-700"
                      >
                        None
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 max-h-56 overflow-auto">
                    {[
                      ...(discovered?.tables || []).map((t) => ({ n: t, k: 'TABLE' })),
                      ...(discovered?.views || []).map((v) => ({ n: v, k: 'VIEW' }))
                    ].map(
                      ({ n, k }) => {
                        const upName = (n || '').toUpperCase();
                        const isStaging = upName.startsWith('STG_') || upName.startsWith('RAW_');
                        const isMart = upName.startsWith('MART_') || upName.startsWith('VW_') || k === 'VIEW';
                        const zoneLabel = isStaging ? 'STAGING' : isMart ? 'CONSUMPTION' : 'CORE DWH';
                        const zoneColor = isStaging ? 'text-amber-400' : isMart ? 'text-teal-400' : 'text-blue-400';

                        return (
                          <label key={n} className="flex items-center gap-1.5 p-1.5 rounded-lg bg-slate-900/60 border border-slate-800 hover:border-slate-700 text-xs text-slate-300 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedObjects.includes(n)}
                              onChange={(e) =>
                                setSelectedObjects((prev) =>
                                  e.target.checked ? [...prev, n] : prev.filter((x) => x !== n)
                                )
                              }
                            />
                            <div className="min-w-0 flex-1 truncate">
                              <span className="font-mono text-[11px] truncate">{n}</span>
                              <div className={`text-[9px] font-bold ${zoneColor}`}>{zoneLabel}</div>
                            </div>
                          </label>
                        );
                      }
                    )}
                  </div>
                </div>
              )}

              <div>
                <button
                  type="button"
                  disabled={busy || !activeConn || !canEdit || (discovered?.ok && selectedObjects.length === 0)}
                  onClick={() =>
                    run(async () => {
                      if (!activeConn) return;
                      const res = await api.reverseEngineerFromConnection(
                        activeConn.id,
                        project,
                        subjectArea || 'Core',
                        discovered?.ok ? selectedObjects : null,
                        mergeIntoProject,
                        authToken
                      );
                      setExtractedDdl(res.extracted_ddl);
                      setProject(res.project, true);
                      await refreshCompiledCode();
                      setStatusBanner({
                        type: 'success',
                        message: `Imported ${res.entities_parsed} object(s) across zones with verified definitions into canvas!`,
                      });
                      setTimeout(() => {
                        window.dispatchEvent(new CustomEvent('metaforge:auto-layout'));
                      }, 200);
                    })
                  }
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-xs text-white font-bold shadow-lg disabled:opacity-40"
                >
                  <Download className="w-4 h-4" /> 2. Reverse Engineer into Canvas
                </button>
              </div>

              {extractedDdl && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
                    Extracted DDL (from Live Database Catalog)
                  </div>
                  <pre className="text-[11px] font-mono bg-slate-950 border border-slate-800 rounded-xl p-3 max-h-56 overflow-auto text-slate-300 whitespace-pre-wrap">
                    {extractedDdl}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* ===================================================================
              3. Excel / CSV File Ingestion & Profiling Tab
              =================================================================== */}
          {tab === 'files' && (
            <div className="flex flex-col gap-4">
              <div className="p-4 rounded-xl border border-dashed border-slate-700 bg-slate-950/60 flex flex-col items-center justify-center gap-2">
                <FileSpreadsheet className="w-8 h-8 text-emerald-400" />
                <div className="text-center">
                  <span className="text-xs font-bold text-slate-200">Upload Excel Workbook (.xlsx) or CSV File</span>
                  <p className="text-[10px] text-slate-400 mt-0.5">
                    Parses all worksheets via pure standard library, infers SQL types, runs in-memory profiling, and auto-generates definitions.
                  </p>
                </div>
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv,.txt"
                  disabled={uploading}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    setUploading(true);
                    setError(null);
                    try {
                      const summary = await api.uploadFileForInspection(f, authToken);
                      setFileInspection(summary);
                      setSelectedSheets(summary.sheets.map((s) => s.sheet_name));
                      setFilePreviewSheet(summary.sheets[0] || null);
                      setStatusBanner({
                        type: 'success',
                        message: `Inspected ${summary.filename}: discovered ${summary.total_sheets} sheet(s) and ${summary.total_rows.toLocaleString()} rows.`,
                      });
                    } catch (err: any) {
                      setError(err.message || 'File inspection failed');
                    } finally {
                      setUploading(false);
                    }
                  }}
                  className="text-xs text-slate-400 file:mr-2 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-500 cursor-pointer"
                />
              </div>

              {/* Inspected Sheets Summary */}
              {fileInspection && (
                <div className="border border-slate-800 rounded-xl p-3.5 bg-slate-950 space-y-3">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                    <div>
                      <span className="text-xs font-bold text-slate-100">
                        {fileInspection.filename} ({fileInspection.file_type.toUpperCase()}) — {fileInspection.total_sheets} Sheet(s)
                      </span>
                      <p className="text-[10px] text-slate-400">
                        Select which worksheets to convert into Canvas Table entities.
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1.5 text-xs text-slate-300">
                        Target Subject Area:
                        <input
                          value={fileSubjectArea}
                          onChange={(e) => setFileSubjectArea(e.target.value)}
                          className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs w-28"
                        />
                      </label>
                      <button
                        type="button"
                        disabled={selectedSheets.length === 0}
                        onClick={() =>
                          run(async () => {
                            const sheetsToCommit = fileInspection.sheets.filter((s) =>
                              selectedSheets.includes(s.sheet_name)
                            );
                            const res = await api.commitFileImport(
                              sheetsToCommit,
                              fileSubjectArea || 'Staging',
                              fileMerge,
                              authToken
                            );
                            setProject(res.project, true);
                            await refreshCompiledCode();
                            setStatusBanner({
                              type: 'success',
                              message: `Imported ${res.entities_imported} table(s) and ${res.relationships_inferred} inferred relationship(s) from spreadsheet into canvas!`,
                            });
                          })
                        }
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs text-white font-bold disabled:opacity-40 shadow"
                      >
                        <Download className="w-3.5 h-3.5" /> Commit to Canvas
                      </button>
                    </div>
                  </div>

                  {/* Sheets Cards */}
                  <div className="grid grid-cols-2 gap-3">
                    {fileInspection.sheets.map((sh) => (
                      <div
                        key={sh.sheet_name}
                        onClick={() => setFilePreviewSheet(sh)}
                        className={`p-3 rounded-xl border cursor-pointer transition-all ${
                          filePreviewSheet?.sheet_name === sh.sheet_name
                            ? 'border-emerald-500 bg-emerald-950/20'
                            : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <label className="flex items-center gap-2 text-xs font-bold text-slate-100 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedSheets.includes(sh.sheet_name)}
                              onChange={(e) =>
                                setSelectedSheets((prev) =>
                                  e.target.checked
                                    ? [...prev, sh.sheet_name]
                                    : prev.filter((x) => x !== sh.sheet_name)
                                )
                              }
                            />
                            <span>{sh.sheet_name}</span>
                          </label>
                          <span className="text-[10px] text-emerald-400 font-mono">
                            {sh.row_count.toLocaleString()} rows • {sh.column_count} cols
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-400 mt-1.5 font-mono truncate">
                          Cols: {sh.columns.map((c) => c.name).join(', ')}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Columns & Profile Preview Table */}
                  {filePreviewSheet && (
                    <div className="pt-2 border-t border-slate-800">
                      <div className="text-[11px] font-bold text-slate-300 mb-1.5 flex items-center justify-between">
                        <span>Column Profiling & Inferred Types for Sheet: {filePreviewSheet.sheet_name}</span>
                        <span className="text-[10px] text-slate-500 font-mono">Table: {filePreviewSheet.table_name}</span>
                      </div>
                      <div className="max-h-48 overflow-auto border border-slate-800 rounded-lg">
                        <table className="w-full text-[11px] text-left border-collapse">
                          <thead className="bg-slate-900 text-slate-400 text-[10px] uppercase font-mono">
                            <tr>
                              <th className="p-2 border-b border-slate-800">Column Name</th>
                              <th className="p-2 border-b border-slate-800">Inferred Type</th>
                              <th className="p-2 border-b border-slate-800">Null %</th>
                              <th className="p-2 border-b border-slate-800">Distinct</th>
                              <th className="p-2 border-b border-slate-800">Candidate PK</th>
                              <th className="p-2 border-b border-slate-800">Sample Values</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800/80 text-slate-300">
                            {filePreviewSheet.columns.map((col) => (
                              <tr key={col.name} className="hover:bg-slate-900/40">
                                <td className="p-2 font-mono font-semibold text-slate-200">{col.name}</td>
                                <td className="p-2 font-mono text-sky-400">{col.inferred_type}</td>
                                <td className="p-2">{col.null_pct}%</td>
                                <td className="p-2 font-mono">{col.distinct_count}</td>
                                <td className="p-2">
                                  {col.is_candidate_pk ? (
                                    <span className="px-1.5 py-0.2 rounded bg-amber-950 text-amber-300 font-bold text-[9px] border border-amber-800">
                                      PK
                                    </span>
                                  ) : (
                                    '—'
                                  )}
                                </td>
                                <td className="p-2 text-slate-400 font-mono text-[10px] truncate max-w-xs">
                                  {col.sample_values.join(', ') || '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Data Dictionary CSV Download Action */}
              <div className="p-3.5 rounded-xl border border-slate-800 bg-slate-950 flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                    <FileText className="w-4 h-4 text-sky-400" />
                    Export Full Enterprise Data Dictionary (CSV)
                  </div>
                  <p className="text-[10px] text-slate-400">
                    Exports all tables, columns, dialect data types, enterprise domains, PII classifications, verified definitions, and profiling metrics as a CSV spreadsheet.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const blob = await api.downloadDataDictionaryCsv(authToken);
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `metaforge_data_dictionary_${new Date().toISOString().slice(0, 10)}.csv`;
                      a.click();
                      URL.revokeObjectURL(url);
                      setStatusBanner({ type: 'success', message: 'Downloaded complete enterprise data dictionary CSV.' });
                    } catch (e: any) {
                      setError(e.message);
                    }
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-100 font-semibold"
                >
                  <Download className="w-3.5 h-3.5 text-sky-400" /> Download Dictionary CSV
                </button>
              </div>
            </div>
          )}

          {/* ===================================================================
              4. Data Profiling & Definitions Synthesis Tab
              =================================================================== */}
          {tab === 'profile' && (
            <div className="flex flex-col gap-4">
              {ConnectionPicker}
              <div className="p-3.5 rounded-xl border border-slate-800 bg-slate-950/60">
                <span className="text-xs font-bold text-slate-200">Live SQL Profiling & Statistical Distribution</span>
                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                  Executes aggregate profiling queries (<code>COUNT</code>, null %, <code>COUNT DISTINCT</code>,{' '}
                  <code>MIN/MAX</code>, sample values) against live tables in the connected database. Profiling stats feed
                  the Inspector and automatic definition generator.
                </p>
                <div className="flex items-center gap-4 text-xs text-slate-300 mt-3">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" checked={profileScope === 'all'} onChange={() => setProfileScope('all')} />
                    All canvas entities
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      checked={profileScope === 'selected'}
                      disabled={!selectedEntityId}
                      onChange={() => setProfileScope('selected')}
                    />
                    Selected entity only
                    {selectedEntityId && (
                      <span className="font-mono text-slate-400">
                        ({project.entities[selectedEntityId]?.physical_name})
                      </span>
                    )}
                  </label>
                </div>
                <div className="mt-3">
                  <button
                    type="button"
                    disabled={busy || !activeConn}
                    onClick={() =>
                      run(async () => {
                        if (!activeConn) return;
                        const res = await api.profileFromConnection(
                          activeConn.id,
                          project,
                          profileScope === 'selected' ? selectedEntityId : null,
                          authToken
                        );
                        setProject(res.project, true);
                        const s = res.stats;
                        const msg = `Profiled ${s.live_tables_profiled} live table(s), ${s.columns_profiled} column(s) — ${s.total_recommendations} DQ recommendation(s).`;
                        setProfileSummary(msg);
                        setStatusBanner({ type: 'success', message: msg });
                      })
                    }
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs text-white font-semibold disabled:opacity-40"
                  >
                    <BarChart3 className="w-3.5 h-3.5" /> Run Live SQL Profiling
                  </button>
                </div>
                {profileSummary && (
                  <div className="mt-3 p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-700 text-emerald-200 text-xs">
                    {profileSummary}
                  </div>
                )}
              </div>

              {/* ✨ Generate Definitions from Profile & Names Card */}
              <div className="p-4 rounded-xl border border-blue-500/30 bg-gradient-to-r from-blue-950/30 to-indigo-950/30 space-y-2.5">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  <span className="text-xs font-bold text-white">
                    Auto-Generate Definitions from Profile & Column Names
                  </span>
                </div>
                <p className="text-[11px] text-slate-300 leading-relaxed">
                  Inspects observed null rates, sample values, categorical enum domains, min/max value bounds, and naming
                  taxonomy (<code>_ID</code>, <code>_AMT</code>, <code>_DT</code>, <code>_CD</code>, <code>_STAT</code>,{' '}
                  <code>_QTY</code>) to generate comprehensive, publication-ready business descriptions for tables and columns.
                </p>
                <div className="pt-1">
                  <button
                    type="button"
                    disabled={isGeneratingDefs}
                    onClick={async () => {
                      setIsGeneratingDefs(true);
                      setError(null);
                      try {
                        const res = await api.generateDefinitionsFromProfile(
                          profileScope === 'selected' ? selectedEntityId : null,
                          true,
                          authToken
                        );
                        setProject(res.project, true);
                        await refreshCompiledCode();
                        const msg = `${res.ai_provider || 'Google Gemini'}: Synthesized definitions for ${res.entities_updated} entities and ${res.columns_updated} columns!`;
                        setGenDefSummary(msg);
                        setStatusBanner({ type: 'success', message: msg });
                      } catch (err: any) {
                        setError(err.message || 'Definition synthesis failed');
                      } finally {
                        setIsGeneratingDefs(false);
                      }
                    }}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 text-xs font-bold shadow-lg disabled:opacity-40"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-slate-950" />
                    {isGeneratingDefs ? 'Synthesizing Definitions...' : '✨ Generate Definitions from Profile & Names'}
                  </button>
                </div>
                {genDefSummary && (
                  <div className="p-2.5 rounded-lg bg-amber-950/40 border border-amber-700/60 text-amber-200 text-xs font-medium">
                    {genDefSummary}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ===================================================================
              5. Push Definitions to Database Tab (SQLite / Snowflake / SQL Server)
              =================================================================== */}
          {tab === 'metadata_push' && (
            <div className="flex flex-col gap-4">
              {ConnectionPicker}

              {/* Target Engine Strategy Indicator */}
              <div className="p-3.5 rounded-xl border border-slate-800 bg-slate-950/80">
                <span className="text-xs font-bold text-slate-200">Target Database Metadata Strategy</span>
                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                  {activeConn?.dialect === 'sqlite' ? (
                    <>
                      SQLite uses the embedded <code>_metaforge_metadata</code> repository table to store full table and column
                      descriptions, logical names, and PII classifications, ensuring complete round-trip preservation.
                    </>
                  ) : activeConn?.dialect === 'snowflake' ? (
                    <>
                      Snowflake will receive native <code>COMMENT ON TABLE</code> and <code>COMMENT ON COLUMN</code> DDL statements.
                    </>
                  ) : activeConn?.dialect === 'sql_server' ? (
                    <>
                      SQL Server will receive <code>sys.sp_addextendedproperty / sp_updateextendedproperty</code> statements for{' '}
                      <code>MS_Description</code> on tables and columns.
                    </>
                  ) : activeConn?.dialect === 'oracle' ? (
                    <>
                      Oracle Database will receive native <code>COMMENT ON TABLE</code> and <code>COMMENT ON COLUMN</code> statements.
                    </>
                  ) : (
                    <>
                      PostgreSQL will receive native <code>COMMENT ON TABLE</code> and <code>COMMENT ON COLUMN</code> statements.
                    </>
                  )}
                </p>

                <div className="flex items-center gap-3 mt-3">
                  <button
                    type="button"
                    disabled={busy || !activeConn}
                    onClick={() =>
                      run(async () => {
                        if (!activeConn) return;
                        const prev = await api.previewPushMetadata(activeConn.id, authToken);
                        setPushPreview(prev);
                        setStatusBanner({
                          type: 'success',
                          message: `Generated ${prev.total_statements} metadata statements for ${prev.connection_name} (${prev.dialect}).`,
                        });
                      })
                    }
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs text-slate-100 font-semibold"
                  >
                    <FileText className="w-3.5 h-3.5 text-sky-400" /> 1. Preview Metadata Statements
                  </button>

                  <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={pushDryRun}
                      onChange={(e) => setPushDryRun(e.target.checked)}
                    />
                    Dry run (validate syntax without mutating database)
                  </label>

                  <button
                    type="button"
                    disabled={busy || !activeConn || !canEdit}
                    onClick={() =>
                      run(async () => {
                        if (!activeConn) return;
                        if (
                          !pushDryRun &&
                          !window.confirm(
                            `Deploy definitions and comments directly to "${activeConn.name}"?`
                          )
                        )
                          return;
                        const rep = await api.pushMetadataToDatabase(activeConn.id, pushDryRun, null, authToken);
                        setPushReport(rep);
                        setStatusBanner({
                          type: rep.ok ? 'success' : 'error',
                          message: `${rep.dry_run ? 'Dry-run validated' : 'Pushed'}: ${rep.statements_executed} statement(s) executed, ${rep.errors} error(s).`,
                        });
                      })
                    }
                    className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-white shadow-md transition-all ${
                      pushDryRun ? 'bg-blue-600 hover:bg-blue-500' : 'bg-emerald-600 hover:bg-emerald-500'
                    }`}
                  >
                    <Send className="w-3.5 h-3.5" />
                    {pushDryRun ? 'Validate Push (Dry Run)' : '2. Deploy Definitions to Database'}
                  </button>
                </div>
              </div>

              {/* Statements Preview */}
              {pushPreview && (
                <div className="border border-slate-800 rounded-xl p-3 bg-slate-950 space-y-2">
                  <div className="text-xs font-bold text-slate-200 flex items-center justify-between">
                    <span>Generated Metadata Statements ({pushPreview.total_statements})</span>
                    <span className="text-[10px] text-sky-400 font-mono capitalize">{pushPreview.dialect} Target</span>
                  </div>
                  <div className="max-h-56 overflow-auto divide-y divide-slate-800/80 font-mono text-[11px] text-slate-300">
                    {pushPreview.statements.slice(0, 50).map((s, i) => (
                      <div key={i} className="py-1.5 flex gap-2">
                        <span className="text-slate-500 w-36 shrink-0 truncate">{s.target}</span>
                        <span className="text-slate-200 truncate">{s.sql}</span>
                      </div>
                    ))}
                    {pushPreview.statements.length > 50 && (
                      <div className="py-1 text-slate-500 text-[10px]">
                        ... and {pushPreview.statements.length - 50} more statements
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Execution Report */}
              {pushReport && (
                <div className="border border-slate-700 rounded-xl overflow-hidden">
                  <div className="px-3.5 py-2.5 bg-slate-800 text-xs text-slate-200 font-bold flex items-center justify-between">
                    <span>
                      {pushReport.dry_run ? 'Dry Run Validation Report' : 'Live Metadata Deployment Report'} —{' '}
                      {pushReport.statements_executed} executed, {pushReport.errors} error(s)
                    </span>
                    <span className={pushReport.ok ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                      {pushReport.ok ? 'SUCCESS' : 'FAILED'}
                    </span>
                  </div>
                  <div className="max-h-56 overflow-auto divide-y divide-slate-800 bg-slate-950">
                    {pushReport.results.map((r, i) => (
                      <div key={i} className="px-3 py-2 text-[11px] flex gap-3">
                        <span
                          className={`shrink-0 w-28 font-semibold ${
                            r.status === 'SUCCESS' || r.status === 'DRY_RUN_VALIDATED'
                              ? 'text-emerald-400'
                              : 'text-rose-400'
                          }`}
                        >
                          {r.status}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-slate-300 truncate">{r.target} — {r.sql}</div>
                          <div className="text-slate-500 text-[10px]">{r.message}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ===================================================================
              6. Apply DDL Tab
              =================================================================== */}
          {tab === 'ddl' && (
            <div className="flex flex-col gap-3">
              {ConnectionPicker}
              <div className="flex items-center gap-3 text-xs text-slate-300">
                <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Script:</span>
                <select
                  value={ddlSource}
                  onChange={(e) => setDdlSource(e.target.value as typeof ddlSource)}
                  className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs"
                >
                  <option value="snowflake">Compiled Snowflake DDL</option>
                  <option value="sql_server">Compiled SQL Server DDL</option>
                  <option value="oracle">Compiled Oracle DDL</option>
                  <option value="custom">Custom / Complete Compare ALTER script</option>
                </select>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
                  Dry run (validate only)
                </label>
              </div>
              <textarea
                value={ddlScript}
                onChange={(e) => {
                  setDdlScript(e.target.value);
                  setDdlSource('custom');
                }}
                spellCheck={false}
                className="w-full h-64 font-mono text-[11px] bg-slate-950 border border-slate-700 rounded-lg p-3 text-slate-200 outline-none focus:border-blue-500"
                placeholder="Paste DDL or an ALTER script from Complete Compare…"
              />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={busy || !activeConn || !canEdit || !ddlScript.trim()}
                  onClick={() => {
                    if (
                      !dryRun &&
                      !window.confirm(
                        `Execute this script against "${activeConn?.name}"? This changes the live database.`
                      )
                    )
                      return;
                    run(async () => {
                      if (!activeConn) return;
                      const rep = await api.executeDdlOnConnection(activeConn.id, ddlScript, dryRun, authToken);
                      setDdlReport(rep);
                      setStatusBanner({
                        type: rep.ok ? 'success' : 'error',
                        message: `${rep.dry_run ? 'Dry run' : 'Executed'}: ${rep.statements_executed} ok, ${rep.statements_skipped} skipped, ${rep.errors} error(s)`,
                      });
                    });
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-white font-semibold disabled:opacity-40 ${
                    dryRun ? 'bg-blue-600 hover:bg-blue-500' : 'bg-rose-600 hover:bg-rose-500'
                  }`}
                >
                  <Play className="w-3.5 h-3.5" /> {dryRun ? 'Validate (Dry Run)' : 'Execute on Database'}
                </button>
                {!canEdit && <span className="text-[11px] text-amber-400">Only Admin / Data Architect can apply DDL.</span>}
              </div>

              {ddlReport && (
                <div className="border border-slate-700 rounded-lg overflow-hidden">
                  <div className="px-3 py-2 bg-slate-800 text-xs text-slate-200 font-semibold">
                    {ddlReport.dry_run ? 'Dry-run report' : 'Execution report'} — {ddlReport.statements_executed} ok ·{' '}
                    {ddlReport.statements_skipped} skipped · {ddlReport.errors} error(s)
                  </div>
                  <div className="max-h-64 overflow-auto divide-y divide-slate-800">
                    {ddlReport.results.map((r, i) => (
                      <div key={i} className="px-3 py-2 text-[11px] flex gap-3">
                        <span
                          className={`shrink-0 w-28 font-semibold ${
                            r.status === 'SUCCESS' || r.status === 'DRY_RUN_VALIDATED'
                              ? 'text-emerald-400'
                              : r.status === 'SKIPPED'
                              ? 'text-slate-400'
                              : 'text-rose-400'
                          }`}
                        >
                          {r.status}
                        </span>
                        <div className="min-w-0">
                          <div className="font-mono text-slate-300 truncate">{r.sql}</div>
                          <div className="text-slate-500">{r.message}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ConnectionsModal;
