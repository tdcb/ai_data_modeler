import React, { useMemo, useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, Crosshair, Key, Link2, Loader2, Sparkles, Wand2 } from 'lucide-react';
import { openThreadCounts, useCollabStore } from '../../store/useCollabStore';
import { MessageSquare } from 'lucide-react';
import { useModelStore } from '../../store/useModelStore';
import { aiApi } from '../../services/aiApi';
import { Markdown } from '../common/Markdown';
import type { ColumnModel, PiiClassification } from '../../types/metamodel';

type Tab = 'tables' | 'relationships' | 'glossary';
const TYPE_FIELD: Record<string, keyof ColumnModel> = {
  snowflake: 'data_type_snowflake',
  sql_server: 'data_type_sql_server',
  oracle: 'data_type_oracle',
};
const PII: PiiClassification[] = ['NONE', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED_PII'];

const cell =
  'w-full bg-transparent border border-transparent hover:border-slate-700 focus:border-indigo-500 focus:bg-slate-900 rounded px-1 py-0.5 outline-none';

export const openCompanion = (detail: { tab: string; entityIds?: string[]; query?: string }) =>
  window.dispatchEvent(new CustomEvent('metaforge:ai-companion', { detail }));

/** Data dictionary: every definition in the model, editable inline and synced with Canvas/Editor/AI. */
export const DataDictionary: React.FC = () => {
  const project = useModelStore((s) => s.project);
  const activeSubjectArea = useModelStore((s) => s.activeSubjectArea);
  const targetDialect = useModelStore((s) => s.targetDialect);
  const selectedEntityId = useModelStore((s) => s.selectedEntityId);
  const selectedColumnId = useModelStore((s) => s.selectedColumnId);
  const updateEntity = useModelStore((s) => s.updateEntity);
  const updateColumn = useModelStore((s) => s.updateColumn);
  const updateRelationship = useModelStore((s) => s.updateRelationship);
  const selectEntity = useModelStore((s) => s.selectEntity);
  const focusEntity = useModelStore((s) => s.focusEntity);
  const setWorkspaceView = useModelStore((s) => s.setWorkspaceView);
  const authToken = useModelStore((s) => s.authToken);

  const [tab, setTab] = useState<Tab>('tables');
  const comments = useCollabStore((s) => s.comments);
  const peers = useCollabStore((s) => s.peers);
  const youId = useCollabStore((s) => s.you?.client_id);
  const openCollab = useCollabStore((s) => s.openPanel);
  const threadCounts = useMemo(() => openThreadCounts(comments), [comments]);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [explainFor, setExplainFor] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<{ md: string; source: string } | null>(null);
  const [explaining, setExplaining] = useState(false);
  const typeField = TYPE_FIELD[targetDialect] || 'data_type_snowflake';

  const entities = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return Object.values(project.entities)
      .filter((e) => activeSubjectArea === 'All' || e.subject_area.toLowerCase() === activeSubjectArea.toLowerCase())
      .filter(
        (e) =>
          !q ||
          `${e.physical_name} ${e.logical_name} ${e.description}`.toLowerCase().includes(q) ||
          e.columns.some((c) => `${c.physical_name} ${c.logical_name} ${c.description}`.toLowerCase().includes(q))
      )
      .sort((a, b) => a.physical_name.localeCompare(b.physical_name));
  }, [project.entities, activeSubjectArea, filter]);

  const stats = useMemo(() => {
    const cols = Object.values(project.entities).flatMap((e) => e.columns);
    const documented = cols.filter((c) => c.description && !c.description.endsWith(' attribute.')).length;
    return { tables: Object.keys(project.entities).length, cols: cols.length, documented };
  }, [project.entities]);

  const explain = async (target: { entity_id?: string; column_id?: string; relationship_id?: string }, key: string) => {
    setExplainFor(key);
    setExplaining(true);
    setExplanation(null);
    try {
      const provider = localStorage.getItem('aidm_provider') || undefined;
      const res = await aiApi.explain(project, target, provider, authToken);
      setExplanation({ md: res.markdown, source: res.source });
    } catch (e) {
      setExplanation({ md: `**Error:** ${e instanceof Error ? e.message : String(e)}`, source: '' });
    } finally {
      setExplaining(false);
    }
  };

  const ExplainPanel = ({ k }: { k: string }) =>
    explainFor === k ? (
      <div className="mx-3 my-2 p-3 rounded-lg bg-violet-950/30 border border-violet-800/50 text-xs text-slate-300">
        {explaining ? (
          <span className="flex items-center gap-1.5 text-violet-300">
            <Loader2 className="w-3 h-3 animate-spin" /> Explaining…
          </span>
        ) : (
          explanation && (
            <>
              <Markdown text={explanation.md} />
              <div className="mt-2 flex justify-between text-[10px] text-slate-500">
                <span>{explanation.source}</span>
                <button type="button" className="hover:text-white" onClick={() => setExplainFor(null)}>
                  close
                </button>
              </div>
            </>
          )
        )}
      </div>
    ) : null;

  return (
    <div className="h-full flex flex-col bg-slate-950 min-h-0" data-testid="data-dictionary">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-800 text-xs shrink-0">
        <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
        <span className="font-semibold text-slate-200">Data Dictionary</span>
        <span className="text-[10px] text-slate-500">
          {stats.tables} objects · {stats.cols} columns · {stats.cols ? Math.round((stats.documented / stats.cols) * 100) : 0}% documented
        </span>
        <div className="flex gap-1 ml-3">
          {(['tables', 'relationships', 'glossary'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-2 py-0.5 rounded capitalize ${tab === t ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              {t}
            </button>
          ))}
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter definitions…"
          className="ml-auto w-56 bg-slate-900 border border-slate-700 rounded px-2 py-0.5 text-xs outline-none focus:border-indigo-500"
        />
        <button
          type="button"
          onClick={() => openCompanion({ tab: 'document' })}
          className="flex items-center gap-1 px-2 py-0.5 rounded bg-violet-700 hover:bg-violet-600 text-white"
        >
          <Wand2 className="w-3 h-3" /> AI document
        </button>
      </div>

      <div className="flex-1 overflow-auto min-h-0 text-xs">
        {tab === 'tables' &&
          entities.map((e) => {
            const open = !collapsed[e.id];
            return (
              <div key={e.id} className={`border-b border-slate-800/80 ${selectedEntityId === e.id ? 'bg-indigo-950/20' : ''}`}>
                <div className="flex items-start gap-2 px-3 py-2">
                  <button type="button" onClick={() => setCollapsed({ ...collapsed, [e.id]: open })} className="mt-1 text-slate-500">
                    {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  </button>
                  <span className="w-2 h-2 rounded-full mt-2 shrink-0" style={{ background: e.header_color || '#2563eb' }} />
                  <div className="w-56 shrink-0">
                    <input
                      className={`${cell} font-mono font-semibold text-white`}
                      value={e.physical_name}
                      onChange={(ev) => updateEntity(e.id, { physical_name: ev.target.value.toUpperCase() })}
                    />
                    <input
                      className={`${cell} text-slate-400`}
                      value={e.logical_name}
                      onChange={(ev) => updateEntity(e.id, { logical_name: ev.target.value })}
                    />
                    <div className="px-1 text-[10px] text-slate-500 flex items-center gap-1">
                      {e.entity_type} · {e.database_schema} · {e.subject_area}
                      {peers
                        .filter((p) => p.client_id !== youId && p.selection?.entity_id === e.id)
                        .map((p) => (
                          <span key={p.client_id} data-testid="dict-peer" title={`${p.name} is here`} className="w-2 h-2 rounded-full" style={{ background: p.color }} />
                        ))}
                    </div>
                  </div>
                  <textarea
                    className={`${cell} flex-1 resize-y min-h-[44px] text-slate-300`}
                    value={e.description}
                    placeholder="Business definition…"
                    onChange={(ev) => updateEntity(e.id, { description: ev.target.value, metadata_status: 'DRAFT' })}
                  />
                  <div className="flex flex-col gap-1 shrink-0">
                    <button
                      type="button"
                      title="Show on canvas"
                      onClick={() => {
                        setWorkspaceView('split');
                        focusEntity(e.id);
                      }}
                      className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
                    >
                      <Crosshair className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      data-testid="dict-comment"
                      title="Comments on this table"
                      onClick={() => openCollab('comments', { entity_id: e.id })}
                      className={`relative p-1 rounded hover:bg-slate-800 ${threadCounts[e.id] ? 'text-amber-300' : 'text-slate-500 hover:text-white'}`}
                    >
                      <MessageSquare className="w-3.5 h-3.5" />
                      {threadCounts[e.id] ? (
                        <span className="absolute -top-1 -right-1 text-[8px] font-bold bg-amber-500 text-slate-950 rounded-full px-1">{threadCounts[e.id]}</span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      title="AI explain"
                      onClick={() => explain({ entity_id: e.id }, e.id)}
                      className="p-1 rounded hover:bg-slate-800 text-violet-300"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <ExplainPanel k={e.id} />
                {open && (
                  <table className="w-full mb-2">
                    <thead className="text-[10px] uppercase text-slate-500">
                      <tr>
                        <th className="pl-12 text-left font-medium w-48">Column</th>
                        <th className="text-left font-medium w-44">Logical name</th>
                        <th className="text-left font-medium w-36">Type ({targetDialect})</th>
                        <th className="font-medium w-10">PK</th>
                        <th className="font-medium w-10">Null</th>
                        <th className="text-left font-medium w-32">PII</th>
                        <th className="text-left font-medium">Definition</th>
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {e.columns.map((c) => (
                        <React.Fragment key={c.id}>
                          <tr
                            className={`align-top ${selectedColumnId === c.id ? 'bg-indigo-900/30' : 'hover:bg-slate-900/60'}`}
                            onClick={() => selectEntity(e.id, c.id)}
                          >
                            <td className="pl-12">
                              <div className="flex items-center gap-1">
                                {c.is_pk && <Key className="w-3 h-3 text-amber-400 shrink-0" />}
                                {c.is_fk && <Link2 className="w-3 h-3 text-sky-400 shrink-0" />}
                                <input
                                  className={`${cell} font-mono text-slate-200`}
                                  value={c.physical_name}
                                  onChange={(ev) => updateColumn(e.id, c.id, { physical_name: ev.target.value.toUpperCase() })}
                                />
                              </div>
                            </td>
                            <td>
                              <input
                                className={`${cell} text-slate-300`}
                                value={c.logical_name}
                                onChange={(ev) => updateColumn(e.id, c.id, { logical_name: ev.target.value })}
                              />
                            </td>
                            <td>
                              <input
                                className={`${cell} font-mono text-emerald-300`}
                                value={String(c[typeField] ?? '')}
                                onChange={(ev) => updateColumn(e.id, c.id, { [typeField]: ev.target.value.toUpperCase() })}
                              />
                            </td>
                            <td className="text-center">
                              <input
                                type="checkbox"
                                checked={c.is_pk}
                                onChange={(ev) =>
                                  updateColumn(e.id, c.id, { is_pk: ev.target.checked, is_nullable: ev.target.checked ? false : c.is_nullable })
                                }
                              />
                            </td>
                            <td className="text-center">
                              <input
                                type="checkbox"
                                checked={c.is_nullable}
                                disabled={c.is_pk}
                                onChange={(ev) => updateColumn(e.id, c.id, { is_nullable: ev.target.checked })}
                              />
                            </td>
                            <td>
                              <select
                                className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px]"
                                value={c.pii_classification}
                                onChange={(ev) => updateColumn(e.id, c.id, { pii_classification: ev.target.value as PiiClassification })}
                              >
                                {PII.map((p) => (
                                  <option key={p}>{p}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <input
                                className={`${cell} text-slate-300`}
                                value={c.description}
                                placeholder="Definition…"
                                onChange={(ev) => updateColumn(e.id, c.id, { description: ev.target.value, metadata_status: 'DRAFT' })}
                              />
                            </td>
                            <td>
                              <button
                                type="button"
                                title="AI explain"
                                onClick={() => explain({ entity_id: e.id, column_id: c.id }, c.id)}
                                className="p-1 text-violet-300 hover:text-white"
                              >
                                <Sparkles className="w-3 h-3" />
                              </button>
                            </td>
                          </tr>
                          {explainFor === c.id && (
                            <tr>
                              <td colSpan={8}>
                                <ExplainPanel k={c.id} />
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}

        {tab === 'relationships' && (
          <table className="w-full">
            <thead className="text-[10px] uppercase text-slate-500 sticky top-0 bg-slate-950">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium">Name</th>
                <th className="text-left font-medium">Parent → Child</th>
                <th className="text-left font-medium w-16">Card.</th>
                <th className="text-left font-medium">Business meaning</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {Object.values(project.relationships).map((r) => {
                const p = project.entities[r.parent_entity_id];
                const c = project.entities[r.child_entity_id];
                if (!p || !c) return null;
                const pc = p.columns.find((x) => x.id === r.parent_column_id)?.physical_name || '?';
                const cc = c.columns.find((x) => x.id === r.child_column_id)?.physical_name || '?';
                return (
                  <React.Fragment key={r.id}>
                    <tr className="border-b border-slate-800/70 align-top">
                      <td className="px-3 py-1 font-mono text-slate-300">{r.name}</td>
                      <td className="py-1 font-mono text-slate-400">
                        {p.physical_name}.{pc} → {c.physical_name}.{cc}
                      </td>
                      <td className="py-1 text-slate-400">{r.cardinality}</td>
                      <td>
                        <input
                          className={`${cell} text-slate-300`}
                          value={r.description || ''}
                          placeholder="What does this relationship mean?"
                          onChange={(ev) => updateRelationship(r.id, { description: ev.target.value })}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          onClick={() => explain({ relationship_id: r.id }, r.id)}
                          className="p-1 text-violet-300 hover:text-white"
                        >
                          <Sparkles className="w-3 h-3" />
                        </button>
                      </td>
                    </tr>
                    {explainFor === r.id && (
                      <tr>
                        <td colSpan={5}>
                          <ExplainPanel k={r.id} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}

        {tab === 'glossary' && (
          <div className="p-3 grid grid-cols-3 gap-x-6 gap-y-1">
            {Object.entries(project.glossary?.abbreviations || {})
              .filter(([w, a]) => !filter || `${w} ${a}`.toLowerCase().includes(filter.toLowerCase()))
              .sort()
              .map(([word, abbr]) => (
                <div key={word} className="flex justify-between border-b border-slate-800/60 py-0.5">
                  <span className="text-slate-300">{word}</span>
                  <span className="font-mono text-sky-300">{abbr}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
};
