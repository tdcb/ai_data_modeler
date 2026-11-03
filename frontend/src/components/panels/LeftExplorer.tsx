import React, { useEffect, useState } from 'react';
import {
  FolderKanban,
  Table2,
  Plus,
  Sparkles,
  BookOpen,
  History,
  Search,
  StickyNote,
  Link2,
  X,
  Check,
  RotateCcw,
  BarChart3,
  Database,
  Download,
  FileSpreadsheet,
  Loader2,
} from 'lucide-react';
import { useModelStore } from '../../store/useModelStore';
import type { EnterpriseDomain, RevisionSummary } from '../../types/metamodel';
import { api } from '../../services/api';

export const LeftExplorer: React.FC = () => {
  const project = useModelStore((s) => s.project);
  const activeSubjectArea = useModelStore((s) => s.activeSubjectArea);
  const selectedEntityId = useModelStore((s) => s.selectedEntityId);
  const selectedRelationshipId = useModelStore((s) => s.selectedRelationshipId);
  const authToken = useModelStore((s) => s.authToken);
  const currentUser = useModelStore((s) => s.currentUser);

  const setActiveSubjectArea = useModelStore((s) => s.setActiveSubjectArea);
  const addSubjectArea = useModelStore((s) => s.addSubjectArea);
  const selectEntity = useModelStore((s) => s.selectEntity);
  const selectRelationship = useModelStore((s) => s.selectRelationship);
  const addEntity = useModelStore((s) => s.addEntity);
  const addView = useModelStore((s) => s.addView);
  const addStickyNote = useModelStore((s) => s.addStickyNote);
  const upsertDomain = useModelStore((s) => s.upsertDomain);
  const deleteDomain = useModelStore((s) => s.deleteDomain);
  const updateGlossaryEntry = useModelStore((s) => s.updateGlossaryEntry);
  const deleteGlossaryEntry = useModelStore((s) => s.deleteGlossaryEntry);
  const applyNamingGlossaryAll = useModelStore((s) => s.applyNamingGlossaryAll);
  const autoGenerateMetadata = useModelStore((s) => s.autoGenerateMetadata);
  const isGeneratingMetadata = useModelStore((s) => s.isGeneratingMetadata);
  const runDataProfiler = useModelStore((s) => s.runDataProfiler);
  const applyRecommendedDq = useModelStore((s) => s.applyRecommendedDq);
  const setProject = useModelStore((s) => s.setProject);
  const setStatusBanner = useModelStore((s) => s.setStatusBanner);

  const [searchQuery, setSearchQuery] = useState('');
  const [newSaName, setNewSaName] = useState('');
  const [showAddSa, setShowAddSa] = useState(false);

  // Modals: Enterprise Domains, NSM Glossary, Revision History, Governance/Profiling/Bus Matrix
  const [activeModal, setActiveModal] = useState<
    'domains' | 'glossary' | 'revisions' | 'governance' | null
  >(null);

  // Domain Form State
  const [editingDomain, setEditingDomain] = useState<EnterpriseDomain>({
    id: 'dom-custom',
    name: '',
    logical_type: 'Identifier / String',
    snowflake_type: 'VARCHAR(100)',
    sql_server_type: 'NVARCHAR(100)',
    oracle_type: 'VARCHAR2(100 CHAR)',
    nullable_default: false,
    dbt_tests: ['not_null'],
    description: '',
  });

  // Glossary Form State
  const [glossaryWord, setGlossaryWord] = useState('');
  const [glossaryAbbr, setGlossaryAbbr] = useState('');

  // Revisions State
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);

  useEffect(() => {
    if (activeModal === 'revisions') {
      api
        .listRevisions(authToken)
        .then(setRevisions)
        .catch(() => setRevisions([]));
    }
  }, [activeModal, authToken]);

  const entitiesList = Object.values(project.entities).filter((ent) => {
    const matchesSa =
      activeSubjectArea === 'All' ||
      ent.subject_area.toLowerCase() === activeSubjectArea.toLowerCase();
    const q = searchQuery.toLowerCase().trim();
    const matchesSearch =
      !q ||
      ent.physical_name.toLowerCase().includes(q) ||
      ent.logical_name.toLowerCase().includes(q) ||
      ent.columns.some(
        (c) =>
          c.physical_name.toLowerCase().includes(q) ||
          c.logical_name.toLowerCase().includes(q)
      );
    return matchesSa && matchesSearch;
  });

  const relationshipsList = Object.values(project.relationships);

  return (
    <>
      <aside className="w-72 bg-slate-900 border-r border-slate-800 flex flex-col shrink-0 select-none z-10">
        {/* Subject Areas Bar */}
        <div className="p-3 border-b border-slate-800">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <FolderKanban className="w-3.5 h-3.5 text-blue-400" />
              Subject Areas
            </span>
            <button
              type="button"
              onClick={() => setShowAddSa(!showAddSa)}
              title="Add new Subject Area"
              className="text-slate-400 hover:text-white p-0.5 rounded hover:bg-slate-800"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {showAddSa && (
            <div className="flex items-center gap-1 mb-2">
              <input
                value={newSaName}
                onChange={(e) => setNewSaName(e.target.value)}
                placeholder="e.g. Underwriting"
                className="flex-1 bg-slate-950 text-xs text-white px-2 py-1 rounded border border-slate-700 outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  if (newSaName.trim()) {
                    addSubjectArea(newSaName.trim());
                    setNewSaName('');
                    setShowAddSa(false);
                  }
                }}
                className="p-1 bg-blue-600 text-white rounded hover:bg-blue-500"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <div className="flex flex-wrap gap-1">
            {['All', ...project.subject_areas].map((sa) => {
              const active = activeSubjectArea === sa;
              return (
                <button
                  key={sa}
                  type="button"
                  onClick={() => setActiveSubjectArea(sa)}
                  className={`px-2 py-1 rounded text-xs font-medium transition-all ${
                    active
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                  }`}
                >
                  {sa}
                </button>
              );
            })}
          </div>
        </div>

        {/* Live Database & Data Sources Card (collapsed by default to keep the explorer focused) */}
        <details className="border-b border-slate-800 bg-slate-950/40 group">
          <summary className="px-3 py-2 cursor-pointer list-none flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-slate-400 hover:text-slate-200">
            <span className="flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-emerald-400" />
              Databases &amp; files
            </span>
            <span className="text-slate-600 group-open:rotate-90 transition-transform">›</span>
          </summary>
        <div className="px-3 pb-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-emerald-400" />
              Live DB &amp; Sources
            </span>
            <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-mono bg-emerald-950/80 px-1.5 py-0.5 rounded border border-emerald-800/50">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              SQLite Ready
            </span>
          </div>

          <div className="p-2 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
            <div>
              <div className="text-xs font-bold text-slate-200">
                Demo Warehouse (SQLite)
              </div>
              <div className="text-[10px] text-slate-400">
                3 Zones: Staging, Core DWH, Marts
              </div>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('metaforge:open-connections', { detail: { tab: 'reverse' } })
                  )
                }
                title="Reverse engineer tables & views from SQLite into canvas"
                className="flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-[10px] font-bold transition-all shadow-sm cursor-pointer"
              >
                <Download className="w-3 h-3 text-emerald-400" />
                <span>Reverse Eng</span>
              </button>

              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('metaforge:open-connections', { detail: { tab: 'profile' } })
                  )
                }
                title="Profile SQLite data distributions and synthesize business definitions"
                className="flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/30 text-[10px] font-bold transition-all cursor-pointer"
              >
                <BarChart3 className="w-3 h-3 text-sky-400" />
                <span>Profile / Defs</span>
              </button>

              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('metaforge:open-connections', { detail: { tab: 'files' } })
                  )
                }
                title="Upload Excel worksheets or CSV files into canvas entities"
                className="flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-violet-600/20 hover:bg-violet-600/30 text-violet-300 border border-violet-500/30 text-[10px] font-bold transition-all cursor-pointer"
              >
                <FileSpreadsheet className="w-3 h-3 text-violet-400" />
                <span>Excel / CSV</span>
              </button>

              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('metaforge:open-connections', { detail: { tab: 'connections' } })
                  )
                }
                title="Add, configure or test database connections (Snowflake, SQL Server, Oracle, PostgreSQL)"
                className="flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-[10px] font-bold transition-all cursor-pointer"
              >
                <Database className="w-3 h-3 text-slate-400" />
                <span>Manage DBs</span>
              </button>
            </div>
          </div>
        </div>
        </details>


        {/* Quick Canvas Creation + Filter Search */}
        <div className="p-3 border-b border-slate-800 space-y-2">
          <div className="grid grid-cols-3 gap-1.5">
            <button
              type="button"
              onClick={() => addEntity()}
              disabled={
                currentUser.role === 'Viewer' ||
                currentUser.role === 'Data Steward'
              }
              className="flex items-center justify-center gap-1 py-1.5 px-1.5 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 text-[11px] font-semibold disabled:opacity-40 transition-colors"
            >
              <Plus className="w-3 h-3" />
              <span>Table</span>
            </button>
            <button
              type="button"
              onClick={() => addView(false)}
              disabled={
                currentUser.role === 'Viewer' ||
                currentUser.role === 'Data Steward'
              }
              title="Create a SQL View that auto-generates background SQL"
              className="flex items-center justify-center gap-1 py-1.5 px-1.5 rounded-lg bg-cyan-600/20 hover:bg-cyan-600/30 text-cyan-300 border border-cyan-500/30 text-[11px] font-semibold disabled:opacity-40 transition-colors"
            >
              <Plus className="w-3 h-3" />
              <span>SQL View</span>
            </button>
            <button
              type="button"
              onClick={addStickyNote}
              className="flex items-center justify-center gap-1 py-1.5 px-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 text-[11px] font-semibold transition-colors"
            >
              <StickyNote className="w-3 h-3" />
              <span>Note</span>
            </button>
          </div>

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search entities, views, columns..."
              className="w-full bg-slate-950 text-xs text-slate-200 pl-8 pr-2.5 py-1.5 rounded-lg border border-slate-800 focus:border-blue-500 outline-none"
            />
          </div>
        </div>

        {/* Entities & Relationships Explorer Tree */}
        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {/* Entities Section */}
          <div>
            <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">
              <span className="flex items-center gap-1.5">
                <Table2 className="w-3.5 h-3.5 text-sky-400" />
                Tables &amp; Views ({entitiesList.length})
              </span>
            </div>

            <div className="space-y-1">
              {entitiesList.map((ent) => {
                const isSelected = selectedEntityId === ent.id;
                const isEntView =
                  ent.entity_type === 'view' ||
                  ent.entity_type === 'materialized_view';
                return (
                  <button
                    key={ent.id}
                    type="button"
                    onClick={() => selectEntity(ent.id, null)}
                    className={`w-full text-left px-2.5 py-2 rounded-lg flex items-center justify-between gap-2 transition-colors ${
                      isSelected
                        ? 'bg-blue-600/20 border border-blue-500/40 text-white'
                        : 'hover:bg-slate-800/70 text-slate-300 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        style={{ backgroundColor: ent.header_color }}
                        className="w-2.5 h-2.5 rounded-sm shrink-0"
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold truncate font-mono flex items-center gap-1.5">
                          <span className="truncate">{ent.physical_name}</span>
                          {isEntView && (
                            <span className="px-1 py-0.2 rounded text-[9px] bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                              VIEW
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-400 truncate">
                          {ent.logical_name} • {ent.subject_area}
                        </div>
                      </div>
                    </div>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-950 text-slate-400">
                      {ent.columns.length}c
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Relationships Section */}
          <div>
            <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">
              <span className="flex items-center gap-1.5">
                <Link2 className="w-3.5 h-3.5 text-amber-400" />
                Relations &amp; Lineage ({relationshipsList.length})
              </span>
            </div>
            <div className="space-y-1">
              {relationshipsList.map((rel) => {
                const pEnt = project.entities[rel.parent_entity_id];
                const cEnt = project.entities[rel.child_entity_id];
                const isSel = selectedRelationshipId === rel.id;
                return (
                  <button
                    key={rel.id}
                    type="button"
                    onClick={() => selectRelationship(rel.id)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg text-[11px] transition-colors ${
                      isSel
                        ? 'bg-sky-500/20 border border-sky-500/40 text-sky-200'
                        : 'hover:bg-slate-800/60 text-slate-400'
                    }`}
                  >
                    <div className="font-mono font-medium text-slate-200 truncate">
                      {pEnt?.physical_name || '?'} → {cEnt?.physical_name || '?'}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                      <span>
                        {rel.rel_type === 'identifying'
                          ? 'Identifying (Solid)'
                          : rel.rel_type === 'upstream_lineage'
                          ? 'Upstream → Downstream Lineage'
                          : 'Non-Identifying (Dashed)'}
                      </span>
                      <span>•</span>
                      <span className="text-sky-400 font-mono">
                        {rel.cardinality}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Bottom Governance Standards Launchpad (collapsed by default) */}
        <details className="border-t border-slate-800 bg-slate-950/60 group">
          <summary className="px-3 py-2 cursor-pointer list-none flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-slate-400 hover:text-slate-200">
            <span>Standards &amp; governance</span>
            <span className="text-slate-600 group-open:rotate-90 transition-transform">›</span>
          </summary>
        <div className="px-3 pb-3 space-y-1.5">

          <button
            type="button"
            onClick={() => setActiveModal('domains')}
            className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-200 transition-colors"
          >
            <span className="flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-violet-400" />
              <span>Enterprise Domains</span>
            </span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300">
              {Object.keys(project.domains).length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveModal('glossary')}
            className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-200 transition-colors"
          >
            <span className="flex items-center gap-2">
              <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
              <span>Naming Glossary (NSM)</span>
            </span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
              {Object.keys(project.glossary.abbreviations).length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveModal('governance')}
            className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-200 transition-colors"
          >
            <span className="flex items-center gap-2">
              <BarChart3 className="w-3.5 h-3.5 text-cyan-400" />
              <span>Profiling, Retention &amp; Bus Matrix</span>
            </span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300">
              AI/DQ
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveModal('revisions')}
            className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-200 transition-colors"
          >
            <span className="flex items-center gap-2">
              <History className="w-3.5 h-3.5 text-amber-400" />
              <span>Revision History</span>
            </span>
            <span className="text-[10px] font-mono text-slate-400">Git/DB</span>
          </button>
        </div>
        </details>

      </aside>

      {/* MODAL 1: Enterprise Domain Manager */}
      {activeModal === 'domains' && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-violet-400" />
                  Enterprise Domains Manager
                </h2>
                <p className="text-xs text-slate-400">
                  Define reusable semantic domains once; updating a domain automatically cascades physical data types across Snowflake, SQL Server, and Oracle for all bound columns.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="text-slate-400 hover:text-white p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto grid grid-cols-1 md:grid-cols-12 gap-6">
              {/* Left: Existing Domains List */}
              <div className="md:col-span-7 space-y-2.5">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Active Enterprise Domains ({Object.keys(project.domains).length})
                </h3>
                {Object.values(project.domains).map((dom) => (
                  <div
                    key={dom.id}
                    onClick={() => setEditingDomain({ ...dom })}
                    className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-violet-500/50 cursor-pointer transition-all space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm text-violet-300">
                        {dom.name}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-slate-400">
                          {dom.logical_type}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteDomain(dom.id);
                          }}
                          className="text-xs text-slate-500 hover:text-rose-400"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-[11px] font-mono pt-1">
                      <div className="bg-slate-900 px-2 py-1 rounded border border-slate-800">
                        <span className="text-sky-400">SF:</span> {dom.snowflake_type}
                      </div>
                      <div className="bg-slate-900 px-2 py-1 rounded border border-slate-800">
                        <span className="text-emerald-400">TSQL:</span> {dom.sql_server_type}
                      </div>
                      <div className="bg-slate-900 px-2 py-1 rounded border border-slate-800">
                        <span className="text-amber-400">ORA:</span> {dom.oracle_type}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Right: Upsert & Cascade Domain Form */}
              <div className="md:col-span-5 bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-violet-300">
                  Create / Edit & Cascade Domain
                </h3>

                <div>
                  <label className="text-[11px] text-slate-400 block mb-1">
                    Domain Name
                  </label>
                  <input
                    value={editingDomain.name}
                    onChange={(e) =>
                      setEditingDomain({
                        ...editingDomain,
                        id:
                          editingDomain.id === 'dom-custom'
                            ? `dom-${e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
                            : editingDomain.id,
                        name: e.target.value,
                      })
                    }
                    placeholder="e.g. Monetary_Amount or ISO_Country_Code"
                    className="w-full bg-slate-900 text-xs text-white px-2.5 py-1.5 rounded border border-slate-700"
                  />
                </div>

                <div>
                  <label className="text-[11px] text-slate-400 block mb-1">
                    Logical Data Type Category
                  </label>
                  <input
                    value={editingDomain.logical_type}
                    onChange={(e) =>
                      setEditingDomain({
                        ...editingDomain,
                        logical_type: e.target.value,
                      })
                    }
                    className="w-full bg-slate-900 text-xs text-white px-2.5 py-1.5 rounded border border-slate-700"
                  />
                </div>

                <div className="grid grid-cols-1 gap-2">
                  <div>
                    <label className="text-[11px] text-sky-400 block mb-1 font-mono">
                      Snowflake Physical Type
                    </label>
                    <input
                      value={editingDomain.snowflake_type}
                      onChange={(e) =>
                        setEditingDomain({
                          ...editingDomain,
                          snowflake_type: e.target.value.toUpperCase(),
                        })
                      }
                      className="w-full bg-slate-900 text-xs font-mono text-white px-2.5 py-1.5 rounded border border-slate-700"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-emerald-400 block mb-1 font-mono">
                      SQL Server (T-SQL) Physical Type
                    </label>
                    <input
                      value={editingDomain.sql_server_type}
                      onChange={(e) =>
                        setEditingDomain({
                          ...editingDomain,
                          sql_server_type: e.target.value.toUpperCase(),
                        })
                      }
                      className="w-full bg-slate-900 text-xs font-mono text-white px-2.5 py-1.5 rounded border border-slate-700"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-amber-400 block mb-1 font-mono">
                      Oracle (PL/SQL) Physical Type
                    </label>
                    <input
                      value={editingDomain.oracle_type}
                      onChange={(e) =>
                        setEditingDomain({
                          ...editingDomain,
                          oracle_type: e.target.value.toUpperCase(),
                        })
                      }
                      className="w-full bg-slate-900 text-xs font-mono text-white px-2.5 py-1.5 rounded border border-slate-700"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    if (!editingDomain.name.trim()) return;
                    upsertDomain(editingDomain);
                  }}
                  className="w-full py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-semibold text-xs shadow"
                >
                  Save Domain & Cascade to Bound Columns
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 2: Enterprise Naming Standards Glossary (NSM) */}
      {activeModal === 'glossary' && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <BookOpen className="w-4 h-4 text-emerald-400" />
                  Enterprise Naming Standards &amp; Glossary
                </h2>
                <p className="text-xs text-slate-400">
                  Standardize logical business terms into enterprise physical UPPER_SNAKE_CASE abbreviations across all tables and columns.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="text-slate-400 hover:text-white p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-4">
              {/* Add Glossary Rule + Auto-Apply All Button */}
              <div className="flex flex-wrap items-end justify-between gap-3 bg-slate-950 p-4 rounded-xl border border-slate-800">
                <div className="flex items-end gap-2 flex-1 min-w-[280px]">
                  <div className="flex-1">
                    <label className="text-[11px] text-slate-400 block mb-1">
                      Business Term (Logical)
                    </label>
                    <input
                      value={glossaryWord}
                      onChange={(e) => setGlossaryWord(e.target.value)}
                      placeholder="e.g. CUSTOMER"
                      className="w-full bg-slate-900 text-xs font-mono text-white px-2.5 py-1.5 rounded border border-slate-700"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-[11px] text-slate-400 block mb-1">
                      Approved Abbreviation (Physical)
                    </label>
                    <input
                      value={glossaryAbbr}
                      onChange={(e) => setGlossaryAbbr(e.target.value)}
                      placeholder="e.g. CUST"
                      className="w-full bg-slate-900 text-xs font-mono text-white px-2.5 py-1.5 rounded border border-slate-700"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (glossaryWord.trim() && glossaryAbbr.trim()) {
                        updateGlossaryEntry(glossaryWord, glossaryAbbr);
                        setGlossaryWord('');
                        setGlossaryAbbr('');
                      }
                    }}
                    className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold border border-slate-700"
                  >
                    + Add Rule
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => applyNamingGlossaryAll()}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow"
                >
                  Apply Glossary to Entire Project Now
                </button>
              </div>

              {/* Abbreviations Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {Object.entries(project.glossary.abbreviations).map(
                  ([word, abbr]) => (
                    <div
                      key={word}
                      className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-between text-xs font-mono"
                    >
                      <div>
                        <span className="text-slate-300">{word}</span>
                        <span className="text-slate-600 mx-1.5">→</span>
                        <span className="text-emerald-400 font-bold">{abbr}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => deleteGlossaryEntry(word)}
                        className="text-slate-600 hover:text-rose-400"
                      >
                        ×
                      </button>
                    </div>
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 3: Revision History & Snapshot Restore */}
      {activeModal === 'revisions' && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <History className="w-4 h-4 text-amber-400" />
                  Model Revision History & Audit Snapshots
                </h2>
                <p className="text-xs text-slate-400">
                  Every save, reverse-engineering import, or agent mutation records an immutable snapshot in SQLite and updates workspace_model/canonical_model.json.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="text-slate-400 hover:text-white p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-2.5">
              {revisions.map((rev) => (
                <div
                  key={rev.id}
                  className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between gap-4"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-mono text-xs font-bold">
                        {rev.revision_tag}
                      </span>
                      <span className="text-xs font-semibold text-white">
                        {rev.commit_message}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 flex items-center gap-2">
                      <span>{rev.author_email}</span>
                      <span>({rev.author_role})</span>
                      <span>•</span>
                      <span>
                        {rev.entity_count} entities / {rev.relationship_count} rels
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const restored = await api.restoreRevision(rev.id, authToken);
                        setProject(restored, true);
                        setActiveModal(null);
                        setStatusBanner({
                          type: 'success',
                          message: `Restored revision ${rev.revision_tag}`,
                        });
                      } catch (err: unknown) {
                        const msg =
                          err instanceof Error ? err.message : 'Restore failed';
                        setStatusBanner({ type: 'error', message: msg });
                      }
                    }}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700 shrink-0"
                  >
                    <RotateCcw className="w-3.5 h-3.5 text-amber-400" />
                    <span>Restore</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* MODAL 4: Enterprise Profiling, Retention Policy & Kimball Bus Matrix */}
      {activeModal === 'governance' && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-5xl max-h-[86vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-cyan-400" />
                  Enterprise Architecture Hub — Profiling, Retention, SLAs &amp; Kimball Bus Matrix
                </h2>
                <p className="text-xs text-slate-400">
                  DAMA-DMBOK Lifecycle Retention, AI Auto-Metadata Generation, Statistical Volumetrics, and Dimensional Conformance Bus Matrix.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="text-slate-400 hover:text-white p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-6 text-xs">
              {/* Top Action Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-950 p-4 rounded-xl border border-slate-800">
                <div className="flex items-center gap-4">
                  <div>
                    <div className="text-[10px] text-slate-400 uppercase">
                      Total Entities
                    </div>
                    <div className="text-base font-bold text-white font-mono">
                      {Object.keys(project.entities).length}
                    </div>
                  </div>
                  <div className="h-8 w-px bg-slate-800" />
                  <div>
                    <div className="text-[10px] text-slate-400 uppercase">
                      Est. Total Rows
                    </div>
                    <div className="text-base font-bold text-emerald-400 font-mono">
                      {Object.values(project.entities)
                        .reduce(
                          (acc, e) =>
                            acc + (e.volumetrics?.estimated_row_count || 0),
                          0
                        )
                        .toLocaleString()}
                    </div>
                  </div>
                  <div className="h-8 w-px bg-slate-800" />
                  <div>
                    <div className="text-[10px] text-slate-400 uppercase">
                      Est. Warehouse Size
                    </div>
                    <div className="text-base font-bold text-sky-400 font-mono">
                      {Object.values(project.entities)
                        .reduce(
                          (acc, e) =>
                            acc + (e.volumetrics?.estimated_size_gb || 0),
                          0
                        )
                        .toFixed(2)}{' '}
                      GB
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isGeneratingMetadata}
                    onClick={() => autoGenerateMetadata(null)}
                    className="px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white font-bold flex items-center gap-1.5 shadow"
                  >
                    {isGeneratingMetadata ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Generating All Metadata...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Auto-Generate All Definitions</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => runDataProfiler(null)}
                    className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold flex items-center gap-1.5 shadow"
                  >
                    <BarChart3 className="w-3.5 h-3.5" />
                    <span>Run Full Profiler</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => applyRecommendedDq(null)}
                    className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-slate-700 font-bold"
                  >
                    + Apply All DQ Rules
                  </button>
                </div>
              </div>

              {/* Section 1: Data Retention, Lifecycle & SLA Governance Matrix */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-indigo-300">
                  1. Data Retention, Lifecycle &amp; Operational SLA Matrix
                </h3>
                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-950 text-slate-400 text-[10px] uppercase border-b border-slate-800">
                        <th className="py-2.5 px-3">Entity / View</th>
                        <th className="py-2.5 px-3">Stereotype</th>
                        <th className="py-2.5 px-3">Regulatory Policy</th>
                        <th className="py-2.5 px-3">Hot / Archive Retention</th>
                        <th className="py-2.5 px-3">Disposition Action</th>
                        <th className="py-2.5 px-3">Freshness SLA</th>
                        <th className="py-2.5 px-3">Est. Rows / Size</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70 bg-slate-900/60">
                      {Object.values(project.entities).map((ent) => (
                        <tr
                          key={ent.id}
                          onClick={() => {
                            selectEntity(ent.id, null);
                            setActiveModal(null);
                          }}
                          className="hover:bg-slate-800/60 cursor-pointer"
                        >
                          <td className="py-2 px-3 font-mono font-bold text-white">
                            {ent.physical_name}
                            <div className="text-[10px] font-sans font-normal text-slate-400">
                              {ent.logical_name}
                            </div>
                          </td>
                          <td className="py-2 px-3 font-mono text-amber-300">
                            {ent.modeling_stereotype || 'DIM_SCD1'}
                          </td>
                          <td className="py-2 px-3 font-mono">
                            <span className="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                              {ent.retention_policy?.regulatory_framework ||
                                'NONE'}
                            </span>
                          </td>
                          <td className="py-2 px-3 font-mono text-slate-300">
                            {ent.retention_policy?.active_retention_days || 365}d
                            hot /{' '}
                            {ent.retention_policy?.archive_retention_days ||
                              2555}
                            d cold
                          </td>
                          <td className="py-2 px-3 font-mono text-slate-300">
                            {ent.retention_policy?.legal_hold ? (
                              <span className="text-rose-400 font-bold">
                                LEGAL HOLD
                              </span>
                            ) : (
                              ent.retention_policy?.disposition_action ||
                              'ARCHIVE'
                            )}
                          </td>
                          <td className="py-2 px-3 font-mono text-sky-300">
                            &lt; {ent.data_contract?.freshness_sla_hours || 24}h (
                            {ent.data_contract?.completeness_sla_pct || 99.5}%)
                          </td>
                          <td className="py-2 px-3 font-mono text-emerald-300">
                            {(
                              ent.volumetrics?.estimated_row_count || 0
                            ).toLocaleString()}{' '}
                            ({ent.volumetrics?.estimated_size_gb || 0.03} GB)
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Section 2: Kimball Enterprise Bus Matrix */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-amber-300">
                  2. Kimball Enterprise Bus Matrix (Fact / Analytical Views vs. Conformed Dimensions)
                </h3>
                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-950 text-slate-400 text-[10px] uppercase border-b border-slate-800">
                        <th className="py-2.5 px-3">
                          Business Process (Fact / Analytical View)
                        </th>
                        {Object.values(project.entities)
                          .filter(
                            (e) =>
                              (e.modeling_stereotype || '').startsWith('DIM') ||
                              e.physical_name.startsWith('DIM_') ||
                              e.dbt_layer === 'staging'
                          )
                          .map((dim) => (
                            <th
                              key={dim.id}
                              className="py-2.5 px-3 font-mono text-sky-300 text-center"
                            >
                              {dim.physical_name}
                            </th>
                          ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70 bg-slate-900/60">
                      {Object.values(project.entities)
                        .filter(
                          (e) =>
                            (e.modeling_stereotype || '').startsWith('FCT') ||
                            e.physical_name.startsWith('FCT_') ||
                            e.entity_type === 'view' ||
                            e.entity_type === 'materialized_view'
                        )
                        .map((fact) => {
                          const dims = Object.values(project.entities).filter(
                            (e) =>
                              (e.modeling_stereotype || '').startsWith('DIM') ||
                              e.physical_name.startsWith('DIM_') ||
                              e.dbt_layer === 'staging'
                          );
                          return (
                            <tr key={fact.id}>
                              <td className="py-2.5 px-3 font-mono font-bold text-white">
                                {fact.physical_name}
                                <div className="text-[10px] font-sans font-normal text-slate-400">
                                  {fact.grain_statement || fact.logical_name}
                                </div>
                              </td>
                              {dims.map((dim) => {
                                const rel = Object.values(
                                  project.relationships
                                ).find(
                                  (r) =>
                                    (r.parent_entity_id === dim.id &&
                                      r.child_entity_id === fact.id) ||
                                    (r.parent_entity_id === fact.id &&
                                      r.child_entity_id === dim.id)
                                );
                                return (
                                  <td
                                    key={dim.id}
                                    className="py-2.5 px-3 text-center font-mono"
                                  >
                                    {rel ? (
                                      <span
                                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                          rel.rel_type === 'identifying'
                                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                            : rel.rel_type === 'upstream_lineage'
                                            ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                                            : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                        }`}
                                      >
                                        {rel.rel_type === 'upstream_lineage'
                                          ? '✓ LINEAGE'
                                          : `✓ FK (${rel.cardinality})`}
                                      </span>
                                    ) : (
                                      <span className="text-slate-700">—</span>
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
