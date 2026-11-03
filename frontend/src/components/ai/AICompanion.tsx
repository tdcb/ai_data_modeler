import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  FileText,
  FileUp,
  Library,
  Loader2,
  MessageSquare,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { useModelStore } from '../../store/useModelStore';
import {
  aiApi,
  type AIProvidersResponse,
  type ContextDoc,
  type DocProposal,
  type ModelSpec,
  type SearchResult,
  type SpecDiff,
} from '../../services/aiApi';
import { Markdown } from '../common/Markdown';

type Tab = 'chat' | 'generate' | 'search' | 'document' | 'context' | 'privacy';

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  meta?: string;
  actions?: string[];
  warnings?: string[];
}

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'generate', label: 'Generate', icon: Wand2 },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'document', label: 'Document', icon: FileText },
  { id: 'context', label: 'Context', icon: Library },
  { id: 'privacy', label: 'Privacy', icon: ShieldCheck },
];

const CHIPS = [
  'Which tables contain Restricted PII?',
  'Add standard audit columns (REC_CRTD_TS, REC_UPDT_TS) to all tables in Core',
  'Create table DIM_SUPPLIER with SUPPLIER_ID number pk, SUPPLIER_NAME varchar not null, COUNTRY_CD varchar',
  'Summarise this model for a new analyst',
];

const SAMPLE_NOTES = `Discovery call transcript — retail loyalty program
[00:01] PM: We need to track members and their purchases. Each member has a first name, last name, email, phone number and join date.
[00:03] Lead: A member can have many loyalty cards. Each loyalty card has a card number, status and issue date.
[00:05] PM: A member makes many purchases. Each purchase has a purchase date, store code and total amount.
[00:07] Lead: A purchase contains many purchase items. Each purchase item has a quantity and unit price.
[00:09] PM: Each purchase item belongs to one product. Products have a name, sku, category and list price.`;

const btn = 'flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-40';

export const AICompanion: React.FC = () => {
  const isOpen = useModelStore((s) => s.isAgentSidebarOpen);
  const setOpen = useModelStore((s) => s.setAgentSidebarOpen);
  const project = useModelStore((s) => s.project);
  const setProject = useModelStore((s) => s.setProject);
  const authToken = useModelStore((s) => s.authToken);
  const currentUser = useModelStore((s) => s.currentUser);
  const selectedEntityId = useModelStore((s) => s.selectedEntityId);
  const selectedColumnId = useModelStore((s) => s.selectedColumnId);
  const selectedRelationshipId = useModelStore((s) => s.selectedRelationshipId);
  const focusEntity = useModelStore((s) => s.focusEntity);
  const selectRelationship = useModelStore((s) => s.selectRelationship);
  const refreshCompiledCode = useModelStore((s) => s.refreshCompiledCode);
  const setStatusBanner = useModelStore((s) => s.setStatusBanner);
  const subjectAreas = project.subject_areas || ['Core'];

  const [tab, setTab] = useState<Tab>('chat');
  const [providers, setProviders] = useState<AIProvidersResponse | null>(null);
  const [provider, setProvider] = useState<string>(() => localStorage.getItem('aidm_provider') || '');
  const [showCfg, setShowCfg] = useState(false);
  const [cfgDraft, setCfgDraft] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [msgs, setMsgs] = useState<Msg[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        '### AI Companion\nAsk questions about the model or tell me what to change — edits flow straight into the **Canvas**, **Dictionary** and **Editor**.\n\nUse **Generate** to build a model from notes, transcripts, briefs or diagrams, **Search** to query the schema in plain English and **Document** to write definitions. Only structural metadata is shared with the AI.',
    },
  ]);
  const [prompt, setPrompt] = useState('');

  const [notes, setNotes] = useState('');
  const [useLibrary, setUseLibrary] = useState(true);
  const [genArea, setGenArea] = useState('Core');
  const [instructions, setInstructions] = useState('');
  const [spec, setSpec] = useState<ModelSpec | null>(null);
  const [diff, setDiff] = useState<SpecDiff | null>(null);

  const [query, setQuery] = useState('');
  const [useAiSearch, setUseAiSearch] = useState(false);
  const [searchRes, setSearchRes] = useState<{ answer: string; results: SearchResult[]; source: string } | null>(null);

  const [docScope, setDocScope] = useState<'all' | 'selected'>('all');
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [proposals, setProposals] = useState<(DocProposal & { accept: boolean })[]>([]);
  const [docSource, setDocSource] = useState('');

  const [docs, setDocs] = useState<ContextDoc[]>([]);
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const [privacy, setPrivacy] = useState<Awaited<ReturnType<typeof aiApi.privacy>> | null>(null);
  const [previewChars, setPreviewChars] = useState<number | null>(null);

  const activeProvider = provider || providers?.active_provider || 'builtin';
  const activeInfo = providers?.providers.find((p) => p.name === activeProvider);
  const canEdit = ['Admin', 'Data Architect', 'Data Steward'].includes(String(currentUser.role));

  const loadProviders = useCallback(async () => {
    try {
      setProviders(await aiApi.providers(authToken));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [authToken]);

  const loadDocs = useCallback(async () => {
    try {
      setDocs(await aiApi.listContext(authToken));
    } catch {
      /* not logged in yet */
    }
  }, [authToken]);

  useEffect(() => {
    if (!isOpen) return;
    loadProviders();
    loadDocs();
  }, [isOpen, loadProviders, loadDocs]);

  useEffect(() => {
    if (tab === 'privacy') aiApi.privacy(authToken).then(setPrivacy).catch(() => {});
    if (tab === 'context') loadDocs();
  }, [tab, authToken, loadDocs]);

  useEffect(() => {
    const h = (ev: Event) => {
      const d = (ev as CustomEvent<{ tab: Tab; entityIds?: string[]; query?: string }>).detail;
      setOpen(true);
      if (d?.tab) setTab(d.tab);
      if (d?.query) setQuery(d.query);
      if (d?.entityIds?.length) setDocScope('selected');
    };
    window.addEventListener('metaforge:ai-companion', h);
    return () => window.removeEventListener('metaforge:ai-companion', h);
  }, [setOpen]);

  useEffect(() => {
    const info = providers?.providers.find((p) => p.name === activeProvider);
    if (!info) return;
    const merged: Record<string, string> = {};
    info.fields.forEach((f) => {
      merged[f] = String(info.config[f] ?? info.defaults[f] ?? '');
    });
    setCfgDraft(merged);
    setTestResult('');
  }, [activeProvider, providers]);

  const chooseProvider = (name: string) => {
    setProvider(name);
    localStorage.setItem('aidm_provider', name);
  };

  const saveCfg = async (makeDefault: boolean) => {
    const conf: Record<string, unknown> = {};
    Object.entries(cfgDraft).forEach(([k, v]) => (conf[k] = k === 'timeout' ? Number(v) || undefined : v));
    await aiApi.saveSettings(
      { providers: { [activeProvider]: conf }, ...(makeDefault ? { active_provider: activeProvider } : {}) },
      authToken
    );
    await loadProviders();
    setStatusBanner({ type: 'success', message: `Saved ${activeInfo?.label || activeProvider} settings` });
  };

  const testCfg = async () => {
    setTestResult('Testing…');
    try {
      const r = await aiApi.testProvider(activeProvider, cfgDraft, authToken);
      setTestResult(r.ok ? `OK — ${r.output.slice(0, 120)}` : `Failed — ${r.output}`);
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : String(e));
    }
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sendChat = (text?: string) => {
    const p = (text ?? prompt).trim();
    if (!p) return;
    setPrompt('');
    const userMsg: Msg = { id: `u-${Date.now()}`, role: 'user', content: p };
    setMsgs((m) => [...m, userMsg]);
    run(async () => {
      const history = msgs.filter((m) => m.id !== 'welcome').map((m) => ({ role: m.role, content: m.content }));
      const res = await aiApi.chat(project, p, history, activeProvider, authToken);
      if (res.mutated && res.updated_model) {
        setProject(res.updated_model);
        refreshCompiledCode();
      }
      setMsgs((m) => [
        ...m,
        { id: `a-${Date.now()}`, role: 'assistant', content: res.reply, meta: res.mode_used, actions: res.actions_taken, warnings: res.warnings },
      ]);
    });
  };

  const explainSelection = () =>
    run(async () => {
      const res = await aiApi.explain(
        project,
        { entity_id: selectedEntityId, column_id: selectedColumnId, relationship_id: selectedRelationshipId },
        activeProvider,
        authToken
      );
      setMsgs((m) => [...m, { id: `x-${Date.now()}`, role: 'assistant', content: res.markdown, meta: res.source, warnings: res.warnings }]);
    });

  const generate = () =>
    run(async () => {
      const res = await aiApi.generate(
        { project, text: notes, use_library: useLibrary, subject_area: genArea, instructions, provider: activeProvider },
        authToken
      );
      setSpec(res.spec);
      setDiff(res.diff);
    });

  const applySpec = () =>
    run(async () => {
      if (!spec) return;
      const res = await aiApi.applySpec(project, spec, authToken);
      setProject(res.project);
      refreshCompiledCode();
      setStatusBanner({ type: 'success', message: `Applied generated model: ${res.actions.length} change(s)` });
      setSpec(null);
      setDiff(null);
      setTimeout(() => window.dispatchEvent(new Event('metaforge:auto-layout')), 150);
    });

  const doSearch = () =>
    run(async () => {
      if (!query.trim()) return;
      setSearchRes(await aiApi.search(project, query, useAiSearch, activeProvider, authToken));
    });

  const propose = () =>
    run(async () => {
      const ids = docScope === 'selected' && selectedEntityId ? [selectedEntityId] : null;
      const res = await aiApi.document(project, ids, onlyMissing, activeProvider, authToken);
      setProposals(res.proposals.map((p) => ({ ...p, accept: true })));
      setDocSource(res.source + (res.warnings.length ? ` — ${res.warnings.join('; ')}` : ''));
    });

  const applyDocs = () =>
    run(async () => {
      const res = await aiApi.applyDocs(project, proposals.filter((p) => p.accept), authToken);
      setProject(res.project);
      refreshCompiledCode();
      setStatusBanner({ type: 'success', message: `Applied ${res.applied} AI definition(s)` });
      setProposals([]);
    });

  const onUpload = (files: FileList | null) =>
    run(async () => {
      if (!files) return;
      for (const f of Array.from(files)) await aiApi.uploadContext(f, authToken);
      await loadDocs();
    });

  if (!isOpen) return null;

  const selLabel = selectedEntityId ? project.entities[selectedEntityId]?.physical_name : selectedRelationshipId ? 'relationship' : '';

  return (
    <aside className="w-[400px] bg-slate-900 border-l border-slate-800 flex flex-col shrink-0 z-10 min-h-0" data-testid="ai-companion">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <Bot className="w-4 h-4 text-violet-400" />
        <span className="text-sm font-semibold text-white">AI Companion</span>
        <select
          value={activeProvider}
          onChange={(e) => chooseProvider(e.target.value)}
          className="ml-auto max-w-[170px] bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200"
          title="LLM provider"
          data-testid="provider-select"
        >
          {(providers?.providers || [{ name: 'builtin', label: 'Built-in (offline, no LLM)', available: true }]).map((p) => (
            <option key={p.name} value={p.name}>
              {p.available ? '● ' : '○ '}
              {p.label}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => setShowCfg(!showCfg)} className="p-1 text-slate-400 hover:text-white" title="Provider settings">
          <Settings2 className="w-4 h-4" />
        </button>
        <button type="button" onClick={() => setOpen(false)} className="p-1 text-slate-400 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>

      {showCfg && activeInfo && (
        <div className="px-3 py-2 border-b border-slate-800 bg-slate-950/60 text-[11px] space-y-1.5">
          <div className="text-slate-400">
            {activeInfo.kind === 'cli'
              ? `${activeInfo.label} runs headless on the backend machine and reuses its existing login.`
              : activeInfo.name === 'devin'
              ? 'Each request runs as a Devin cloud session that analyses it against the model metadata. Needs DEVIN_API_KEY on the backend; replies can take a few minutes.'
              : activeInfo.kind === 'api'
              ? 'API key is read from Profile → AI API Keys or the backend environment.'
              : 'Deterministic, offline engine — nothing leaves this machine.'}
            {!activeInfo.available && activeInfo.kind !== 'offline' && (
              <span className="text-amber-300"> Not detected on the backend PATH / environment.</span>
            )}
          </div>
          {activeInfo.fields.map((f) => (
            <label key={f} className="flex items-center gap-2">
              <span className="w-20 text-slate-500 capitalize">{f.replace('_', ' ')}</span>
              <input
                value={cfgDraft[f] || ''}
                onChange={(e) => setCfgDraft({ ...cfgDraft, [f]: e.target.value })}
                className="flex-1 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 font-mono"
              />
            </label>
          ))}
          <div className="flex gap-1.5">
            <button type="button" onClick={testCfg} className={`${btn} bg-slate-800 hover:bg-slate-700 text-slate-200`}>
              Test
            </button>
            <button type="button" onClick={() => saveCfg(false)} className={`${btn} bg-slate-800 hover:bg-slate-700 text-slate-200`}>
              Save
            </button>
            <button type="button" onClick={() => saveCfg(true)} className={`${btn} bg-violet-700 hover:bg-violet-600 text-white`}>
              Save as default
            </button>
          </div>
          {testResult && <div className="text-slate-300 break-words">{testResult}</div>}
        </div>
      )}

      <div className="flex border-b border-slate-800 text-[11px]">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            data-testid={`ai-tab-${t.id}`}
            className={`flex-1 flex flex-col items-center gap-0.5 py-1.5 ${
              tab === t.id ? 'text-violet-300 border-b-2 border-violet-500 bg-slate-800/40' : 'text-slate-400 hover:text-white'
            }`}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mx-3 mt-2 p-2 rounded bg-rose-950/60 border border-rose-800 text-[11px] text-rose-200 flex justify-between gap-2">
          <span className="break-words">{error}</span>
          <button type="button" onClick={() => setError('')}>
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto min-h-0 p-3 text-xs text-slate-300 space-y-3">
        {tab === 'chat' && (
          <>
            {msgs.map((m) => (
              <div
                key={m.id}
                className={`rounded-lg p-2.5 ${m.role === 'user' ? 'bg-indigo-950/50 border border-indigo-800/50 ml-6' : 'bg-slate-800/60 border border-slate-700/60'}`}
              >
                {m.role === 'user' ? <div className="whitespace-pre-wrap">{m.content}</div> : <Markdown text={m.content} />}
                {m.actions && m.actions.length > 0 && (
                  <div className="mt-2 space-y-0.5">
                    {m.actions.map((a, i) => (
                      <div key={i} className="flex gap-1 text-emerald-300 text-[11px]">
                        <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" />
                        <Markdown text={a} />
                      </div>
                    ))}
                  </div>
                )}
                {m.warnings?.map((w, i) => (
                  <div key={i} className="mt-1 text-amber-300 text-[11px]">
                    {w}
                  </div>
                ))}
                {m.meta && <div className="mt-1 text-[10px] text-slate-500">{m.meta}</div>}
              </div>
            ))}
            {busy && (
              <div className="flex items-center gap-1.5 text-violet-300">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Thinking with {activeInfo?.label || activeProvider}…
              </div>
            )}
          </>
        )}

        {tab === 'generate' && (
          <>
            <p className="text-slate-400">
              Paste meeting notes, transcripts, project briefs, requirements, SQL DDL, DBML or Mermaid ER diagrams. The AI proposes a model you can
              review before it lands on the canvas.
            </p>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={9}
              placeholder="e.g. Each customer places many orders. Orders have an order date and total amount…"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 font-mono text-[11px] outline-none focus:border-violet-500"
              data-testid="generate-notes"
            />
            <div className="flex flex-wrap gap-2 items-center">
              <button type="button" onClick={() => setNotes(SAMPLE_NOTES)} className="text-[11px] text-violet-300 hover:underline">
                Load sample transcript
              </button>
              <label className="flex items-center gap-1 ml-auto">
                <input type="checkbox" checked={useLibrary} onChange={(e) => setUseLibrary(e.target.checked)} />
                Include context library ({docs.filter((d) => d.include).length})
              </label>
            </div>
            <div className="flex gap-2">
              <select value={genArea} onChange={(e) => setGenArea(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-1.5 py-1">
                {Array.from(new Set([...subjectAreas, 'Core'])).map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              <input
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Extra instructions (e.g. star schema, SCD2)"
                className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1"
              />
            </div>
            <button type="button" disabled={busy} onClick={generate} className={`${btn} w-full bg-violet-700 hover:bg-violet-600 text-white`} data-testid="generate-btn">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} Generate model
            </button>
            {spec && diff && (
              <div className="rounded-lg border border-violet-800/60 bg-violet-950/20 p-2.5 space-y-2" data-testid="generate-preview">
                {spec.summary && <Markdown text={spec.summary} />}
                <div className="text-[10px] text-slate-500">{spec.source}</div>
                {spec.warnings?.map((w, i) => (
                  <div key={i} className="text-amber-300 text-[11px]">
                    {w}
                  </div>
                ))}
                {spec.tables.map((t) => (
                  <div key={t.name} className="rounded bg-slate-900/80 border border-slate-800 p-1.5">
                    <div className="flex justify-between">
                      <span className="font-mono font-semibold text-white">{t.name}</span>
                      <span className={diff.new_tables.includes(t.name) ? 'text-emerald-300' : 'text-sky-300'}>
                        {diff.new_tables.includes(t.name)
                          ? 'new'
                          : `+${diff.extended_tables.find((x) => x.table === t.name)?.new_columns.length || 0} cols`}
                      </span>
                    </div>
                    <div className="font-mono text-[10px] text-slate-400 leading-relaxed">
                      {t.columns.map((c) => `${c.pk ? '🔑' : c.fk ? '🔗' : ''}${c.name} ${c.type}`).join(' · ')}
                    </div>
                  </div>
                ))}
                <div className="text-[11px] text-slate-400">
                  {spec.relationships.map((r) => `${r.parent} → ${r.child}`).join(', ') || 'No relationships'}
                </div>
                <div className="flex gap-2">
                  <button type="button" disabled={busy || !canEdit} onClick={applySpec} className={`${btn} flex-1 bg-emerald-700 hover:bg-emerald-600 text-white`} data-testid="apply-spec">
                    Add to model
                  </button>
                  <button type="button" onClick={() => setSpec(null)} className={`${btn} bg-slate-800 hover:bg-slate-700 text-slate-200`}>
                    Discard
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'search' && (
          <>
            <div className="flex gap-1.5">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && doSearch()}
                placeholder="Where do we store customer emails?"
                className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 outline-none focus:border-violet-500"
                data-testid="search-input"
              />
              <button type="button" onClick={doSearch} disabled={busy} className={`${btn} bg-violet-700 hover:bg-violet-600 text-white`}>
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              </button>
            </div>
            <div className="flex flex-wrap gap-1">
              {['PII columns', 'date columns in claims', 'tables without description', 'foreign keys to customer'].map((q) => (
                <button key={q} type="button" onClick={() => setQuery(q)} className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] text-slate-300 hover:bg-slate-700">
                  {q}
                </button>
              ))}
              <label className="flex items-center gap-1 ml-auto text-[11px]">
                <input type="checkbox" checked={useAiSearch} onChange={(e) => setUseAiSearch(e.target.checked)} /> Ask the LLM
              </label>
            </div>
            {searchRes && (
              <div className="space-y-1.5" data-testid="search-results">
                <Markdown text={searchRes.answer} className="text-slate-200" />
                <div className="text-[10px] text-slate-500">{searchRes.source}</div>
                {searchRes.results.map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => (r.kind === 'relationship' && r.relationship_id ? selectRelationship(r.relationship_id) : r.entity_id && focusEntity(r.entity_id, r.column_id))}
                    className="w-full text-left rounded bg-slate-800/60 hover:bg-slate-800 border border-slate-700/60 p-1.5"
                  >
                    <div className="flex justify-between gap-2">
                      <span className="font-mono text-white truncate">{r.title}</span>
                      <span className="text-[10px] uppercase text-slate-500">{r.kind}</span>
                    </div>
                    <div className="text-[11px] text-slate-400">{r.subtitle}</div>
                    {r.detail && <div className="text-[11px] text-slate-500 line-clamp-2">{r.detail}</div>}
                    <div className="text-[10px] text-violet-300">{r.reason}</div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'document' && (
          <>
            <div className="flex gap-3 items-center">
              <label className="flex items-center gap-1">
                <input type="radio" checked={docScope === 'all'} onChange={() => setDocScope('all')} /> Whole model
              </label>
              <label className="flex items-center gap-1">
                <input type="radio" checked={docScope === 'selected'} onChange={() => setDocScope('selected')} disabled={!selectedEntityId} /> Selected
                {selectedEntityId ? ` (${project.entities[selectedEntityId]?.physical_name})` : ''}
              </label>
            </div>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> Only missing / placeholder definitions
            </label>
            <button type="button" onClick={propose} disabled={busy} className={`${btn} w-full bg-violet-700 hover:bg-violet-600 text-white`} data-testid="propose-docs">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />} Write definitions
            </button>
            {docSource && <div className="text-[10px] text-slate-500">{docSource}</div>}
            {proposals.length > 0 && (
              <>
                <div className="flex justify-between items-center">
                  <span>
                    {proposals.filter((p) => p.accept).length}/{proposals.length} selected
                  </span>
                  <button type="button" disabled={busy || !canEdit} onClick={applyDocs} className={`${btn} bg-emerald-700 hover:bg-emerald-600 text-white`} data-testid="apply-docs">
                    Apply selected
                  </button>
                </div>
                {proposals.map((p, i) => (
                  <div key={i} className="rounded bg-slate-800/50 border border-slate-700/60 p-1.5 space-y-1">
                    <label className="flex items-center gap-1.5 font-mono text-[11px] text-white">
                      <input
                        type="checkbox"
                        checked={p.accept}
                        onChange={(e) => setProposals(proposals.map((x, j) => (j === i ? { ...x, accept: e.target.checked } : x)))}
                      />
                      {p.label}
                      <span className="ml-auto text-[9px] uppercase text-slate-500">{p.target}</span>
                    </label>
                    {p.current && <div className="text-[10px] text-slate-500 line-through">{p.current}</div>}
                    <textarea
                      value={p.proposed}
                      rows={2}
                      onChange={(e) => setProposals(proposals.map((x, j) => (j === i ? { ...x, proposed: e.target.value } : x)))}
                      className="w-full bg-slate-950 border border-slate-700 rounded p-1 text-[11px]"
                    />
                  </div>
                ))}
              </>
            )}
          </>
        )}

        {tab === 'context' && (
          <>
            <p className="text-slate-400">
              Project knowledge the AI uses when generating and chatting: briefs, notes, transcripts (.vtt/.srt), DDL, DBML/Mermaid diagrams, .docx/.pdf
              and diagram images.
            </p>
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => onUpload(e.target.files)} />
            <button type="button" onClick={() => fileRef.current?.click()} className={`${btn} w-full bg-slate-800 hover:bg-slate-700 text-slate-200 border border-dashed border-slate-600`}>
              <FileUp className="w-3.5 h-3.5" /> Upload documents
            </button>
            <input
              value={pasteTitle}
              onChange={(e) => setPasteTitle(e.target.value)}
              placeholder="Title"
              className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1"
            />
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={4}
              placeholder="…or paste notes here"
              className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-[11px]"
            />
            <button
              type="button"
              disabled={!pasteText.trim() || busy}
              onClick={() =>
                run(async () => {
                  await aiApi.addContextText(pasteTitle || 'Pasted notes', pasteText, authToken);
                  setPasteText('');
                  setPasteTitle('');
                  await loadDocs();
                })
              }
              className={`${btn} w-full bg-violet-700 hover:bg-violet-600 text-white`}
            >
              Add to library
            </button>
            {docs.map((d) => (
              <div key={d.id} className="rounded bg-slate-800/50 border border-slate-700/60 p-1.5">
                <div className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={d.include}
                    title="Use as AI context"
                    onChange={(e) => aiApi.patchContext(d.id, { include: e.target.checked }, authToken).then(loadDocs)}
                  />
                  <span className="font-semibold text-white truncate">{d.title}</span>
                  <span className="ml-auto text-[9px] uppercase text-slate-500">{d.kind.replace('_', ' ')}</span>
                  <button type="button" onClick={() => aiApi.deleteContext(d.id, authToken).then(loadDocs)} className="text-slate-500 hover:text-rose-400">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
                {d.preview && <div className="text-[10px] text-slate-500 line-clamp-2 mt-0.5">{d.preview}</div>}
              </div>
            ))}
          </>
        )}

        {tab === 'privacy' && privacy && (
          <>
            <div
              className={`rounded-lg p-2.5 border ${privacy.settings.metadata_only ? 'bg-emerald-950/30 border-emerald-800/60' : 'bg-amber-950/30 border-amber-800/60'}`}
            >
              <div className="flex items-center gap-1.5 font-semibold text-white">
                <ShieldCheck className="w-4 h-4 text-emerald-400" /> Metadata-only mode {privacy.settings.metadata_only ? 'ON' : 'OFF'}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                Reverse engineering reads structure only — no row counts, profiling, samples or table rows are read or stored.
              </div>
              {String(currentUser.role) === 'Admin' && (
                <button
                  type="button"
                  onClick={() =>
                    aiApi
                      .saveSettings({ privacy: { metadata_only: !privacy.settings.metadata_only } }, authToken)
                      .then(() => aiApi.privacy(authToken).then(setPrivacy))
                  }
                  className="mt-1.5 text-[11px] text-violet-300 hover:underline"
                >
                  {privacy.settings.metadata_only ? 'Allow live profiling (admin)' : 'Re-enable metadata-only mode'}
                </button>
              )}
            </div>
            <div>
              <div className="font-semibold text-slate-200 mb-1">Shared with the AI provider</div>
              {privacy.sent.map((s) => (
                <div key={s} className="text-emerald-300">
                  ✓ {s}
                </div>
              ))}
            </div>
            <div>
              <div className="font-semibold text-slate-200 mb-1">Never shared</div>
              {privacy.never_sent.map((s) => (
                <div key={s} className="text-rose-300">
                  ✕ {s}
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => aiApi.privacyPreview(project, authToken).then((r) => setPreviewChars(r.chars))}
                className={`${btn} flex-1 bg-slate-800 hover:bg-slate-700 text-slate-200`}
              >
                Preview payload size
              </button>
              <button
                type="button"
                disabled={!canEdit}
                onClick={() =>
                  aiApi.scrub(project, authToken).then((r) => {
                    setProject(r.project);
                    setStatusBanner({ type: 'success', message: `Removed row-derived values from ${r.cleared} column(s)` });
                  })
                }
                className={`${btn} flex-1 bg-slate-800 hover:bg-slate-700 text-slate-200`}
              >
                Scrub sample values
              </button>
            </div>
            {previewChars !== null && (
              <div className="text-[11px] text-slate-400">AI payload: {previewChars.toLocaleString()} characters of metadata.</div>
            )}
            <div>
              <div className="font-semibold text-slate-200 mb-1">AI call audit log</div>
              {privacy.audit.length === 0 && <div className="text-slate-500">No external AI calls yet.</div>}
              {privacy.audit.map((a, i) => (
                <div key={i} className="flex justify-between text-[10px] text-slate-400 border-b border-slate-800 py-0.5">
                  <span>{a.ts.replace('T', ' ')}</span>
                  <span>{a.feature}</span>
                  <span className="truncate max-w-[120px]">{a.provider}</span>
                  <span>{a.payload_chars.toLocaleString()} ch</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {tab === 'chat' && (
        <div className="border-t border-slate-800 p-2 space-y-1.5">
          <div className="flex flex-wrap gap-1">
            {selLabel && (
              <button type="button" onClick={explainSelection} className="px-1.5 py-0.5 rounded bg-violet-900/60 text-[10px] text-violet-200 hover:bg-violet-800">
                Explain {selLabel}
              </button>
            )}
            {CHIPS.map((c) => (
              <button key={c} type="button" onClick={() => setPrompt(c)} className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] text-slate-300 hover:bg-slate-700 truncate max-w-[180px]">
                {c}
              </button>
            ))}
          </div>
          <div className="flex gap-1.5">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendChat();
                }
              }}
              rows={2}
              placeholder="Ask or instruct… (Enter to send)"
              className="flex-1 bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs outline-none focus:border-violet-500 resize-none"
              data-testid="chat-input"
            />
            <button type="button" onClick={() => sendChat()} disabled={busy || !prompt.trim()} className={`${btn} bg-violet-700 hover:bg-violet-600 text-white`}>
              <Send className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </aside>
  );
};
