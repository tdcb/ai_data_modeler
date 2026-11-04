import React, { useEffect, useState } from 'react';
import {
  Sliders,
  Key,
  Link2,
  ShieldAlert,
  Sparkles,
  Database,
  Layers,
  Trash2,
  Wand2,
  Lock,
  GitBranch,
  ArrowUpRight,
  ArrowDownRight,
  Code2,
  Plus,
  BarChart3,
  Clock,
  FileCheck2,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  ChevronRight,
} from 'lucide-react';
import {
  synthesizeViewSqlLocal,
  translateLogicalToPhysicalLocal,
  useModelStore,
} from '../../store/useModelStore';
import type {
  Cardinality,
  DataContractSLA,
  DataRetentionPolicy,
  DbtLayer,
  DbtMaterialization,
  DispositionAction,
  EntityObjectType,
  EntityVolumetrics,
  ModelingStereotype,
  PiiClassification,
  RegulatoryFramework,
  RelationshipType,
} from '../../types/metamodel';

const SECTIONS_KEY = 'metaforge_inspector_sections';

function readSections(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(SECTIONS_KEY) || '{}');
  } catch {
    return {};
  }
}

const InspectorSection: React.FC<{
  id: string;
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ id, title, hint, defaultOpen = false, children }) => {
  const [open, setOpen] = useState(() => readSections()[id] ?? defaultOpen);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    localStorage.setItem(SECTIONS_KEY, JSON.stringify({ ...readSections(), [id]: next }));
  };
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-left hover:bg-slate-800/40 rounded-xl"
      >
        <ChevronRight className={`w-3.5 h-3.5 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-300">{title}</span>
        {hint && !open && <span className="ml-auto text-[10px] text-slate-500 truncate">{hint}</span>}
      </button>
      {open && <div className="px-3 pb-3 pt-1 space-y-3">{children}</div>}
    </section>
  );
};

const COLOR_SWATCHES = [
  '#2563eb',
  '#0891b2',
  '#0d9488',
  '#7c3aed',
  '#d97706',
  '#dc2626',
  '#059669',
  '#db2777',
];

const DEFAULT_RETENTION: DataRetentionPolicy = {
  regulatory_framework: 'NONE',
  active_retention_days: 365,
  archive_retention_days: 2555,
  disposition_action: 'ARCHIVE_TO_COLD_STORAGE',
  retention_date_column: null,
  legal_hold: false,
};

const DEFAULT_CONTRACT: DataContractSLA = {
  data_owner: 'Enterprise Data Architecture',
  data_steward: 'steward@metaforge.local',
  producing_system: 'Core Insurance / Guidewire',
  freshness_sla_hours: 24,
  completeness_sla_pct: 99.5,
  tier: 'Tier-1 Mission Critical',
};

const DEFAULT_VOLUMETRICS: EntityVolumetrics = {
  estimated_row_count: 100000,
  avg_row_bytes: 256,
  monthly_growth_pct: 5.0,
  estimated_size_gb: 0.03,
};

export const RightInspector: React.FC = () => {
  const project = useModelStore((s) => s.project);
  const selectedEntityId = useModelStore((s) => s.selectedEntityId);
  const selectedColumnId = useModelStore((s) => s.selectedColumnId);
  const selectedRelationshipId = useModelStore((s) => s.selectedRelationshipId);
  const targetDialect = useModelStore((s) => s.targetDialect);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (selectedEntityId || selectedRelationshipId) setCollapsed(false);
  }, [selectedEntityId, selectedRelationshipId]);
  const currentUser = useModelStore((s) => s.currentUser);

  const updateEntity = useModelStore((s) => s.updateEntity);
  const deleteEntity = useModelStore((s) => s.deleteEntity);
  const selectEntity = useModelStore((s) => s.selectEntity);
  const addColumn = useModelStore((s) => s.addColumn);
  const updateColumn = useModelStore((s) => s.updateColumn);
  const deleteColumn = useModelStore((s) => s.deleteColumn);
  const updateRelationship = useModelStore((s) => s.updateRelationship);
  const deleteRelationship = useModelStore((s) => s.deleteRelationship);
  const connectEntitiesWithRelationship = useModelStore(
    (s) => s.connectEntitiesWithRelationship
  );
  const importColumnsFromUpstream = useModelStore(
    (s) => s.importColumnsFromUpstream
  );
  const autoGenerateMetadata = useModelStore((s) => s.autoGenerateMetadata);
  const isGeneratingMetadata = useModelStore((s) => s.isGeneratingMetadata);
  const runDataProfiler = useModelStore((s) => s.runDataProfiler);
  const applyRecommendedDq = useModelStore((s) => s.applyRecommendedDq);
  const applyModelingPattern = useModelStore((s) => s.applyModelingPattern);
  const verifyMetadata = useModelStore((s) => s.verifyMetadata);

  const [upstreamImportId, setUpstreamImportId] = useState<string>('');
  const [newRelTargetId, setNewRelTargetId] = useState<string>('');
  const [newRelDirection, setNewRelDirection] = useState<
    'downstream' | 'upstream'
  >('downstream');
  const [newRelType, setNewRelType] =
    useState<RelationshipType>('upstream_lineage');

  const isViewer = currentUser.role === 'Viewer';
  const isSteward = currentUser.role === 'Data Steward';
  const isPhysicalLocked = isViewer || isSteward;

  const selectedEntity = selectedEntityId
    ? project.entities[selectedEntityId]
    : null;
  const selectedColumn =
    selectedEntity && selectedColumnId
      ? selectedEntity.columns.find((c) => c.id === selectedColumnId) || null
      : null;
  const selectedRelationship = selectedRelationshipId
    ? project.relationships[selectedRelationshipId]
    : null;

  // Compute Upstream & Downstream relationships for selectedEntity
  const upstreamRels = selectedEntity
    ? Object.values(project.relationships).filter(
        (r) => r.child_entity_id === selectedEntity.id
      )
    : [];
  const downstreamRels = selectedEntity
    ? Object.values(project.relationships).filter(
        (r) => r.parent_entity_id === selectedEntity.id
      )
    : [];

  const otherEntities = selectedEntity
    ? Object.values(project.entities).filter((e) => e.id !== selectedEntity.id)
    : [];

  // Compute Column-Level Lineage (Upstream & Downstream Impact) when a column is selected
  const colUpstreamSources: { entityName: string; colName: string; entityId: string }[] = [];
  const colDownstreamDependents: { entityName: string; colName: string; entityId: string }[] = [];

  if (selectedEntity && selectedColumn) {
    Object.values(project.relationships).forEach((r) => {
      if (
        r.child_entity_id === selectedEntity.id &&
        r.child_column_id === selectedColumn.id
      ) {
        const pEnt = project.entities[r.parent_entity_id];
        const pCol = pEnt?.columns.find((c) => c.id === r.parent_column_id);
        if (pEnt && pCol) {
          colUpstreamSources.push({
            entityName: pEnt.physical_name,
            colName: pCol.physical_name,
            entityId: pEnt.id,
          });
        }
      }
      if (
        r.parent_entity_id === selectedEntity.id &&
        r.parent_column_id === selectedColumn.id
      ) {
        const cEnt = project.entities[r.child_entity_id];
        const cCol = cEnt?.columns.find((c) => c.id === r.child_column_id);
        if (cEnt && cCol) {
          colDownstreamDependents.push({
            entityName: cEnt.physical_name,
            colName: cCol.physical_name,
            entityId: cEnt.id,
          });
        }
      }
    });

    // Also scan View source_expressions across project for references to this column
    Object.values(project.entities).forEach((ent) => {
      if (ent.id === selectedEntity.id) return;
      ent.columns.forEach((c) => {
        if (
          c.source_expression &&
          c.source_expression
            .toUpperCase()
            .includes(selectedColumn.physical_name.toUpperCase())
        ) {
          if (
            !colDownstreamDependents.some(
              (d) => d.entityId === ent.id && d.colName === c.physical_name
            )
          ) {
            colDownstreamDependents.push({
              entityName: ent.physical_name,
              colName: `${c.physical_name} (${c.source_expression})`,
              entityId: ent.id,
            });
          }
        }
      });
    });
  }

  const retention = selectedEntity?.retention_policy || DEFAULT_RETENTION;
  const contract = selectedEntity?.data_contract || DEFAULT_CONTRACT;
  const volumetrics = selectedEntity?.volumetrics || DEFAULT_VOLUMETRICS;

  if (collapsed) {
    return (
      <aside className="w-9 bg-slate-900 border-l border-slate-800 flex flex-col items-center py-2 shrink-0 z-10">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="Show properties"
          className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-800"
        >
          <PanelRightOpen className="w-4 h-4" />
        </button>
        <span className="mt-3 text-[10px] uppercase tracking-wider text-slate-500 [writing-mode:vertical-rl]">Properties</span>
      </aside>
    );
  }

  return (
    <aside className="w-80 bg-slate-900 border-l border-slate-800 flex flex-col shrink-0 z-10 overflow-y-auto">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
          <Sliders className="w-3.5 h-3.5 text-blue-400" />
          Properties
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title="Hide properties"
            className="ml-1 p-0.5 rounded text-slate-500 hover:text-white hover:bg-slate-800"
          >
            <PanelRightClose className="w-3.5 h-3.5" />
          </button>
        </span>
        {isPhysicalLocked && (
          <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[10px] font-semibold flex items-center gap-1">
            <Lock className="w-2.5 h-2.5" />
            {isViewer ? 'Read-Only' : 'Steward Mode'}
          </span>
        )}
      </div>

      {/* Case 1: Relationship Selected */}
      {selectedRelationship && (
        <div className="p-4 space-y-4 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-bold text-sky-400 uppercase tracking-wider text-[11px]">
              Relationship &amp; Lineage Properties
            </span>
            <button
              type="button"
              disabled={isPhysicalLocked}
              onClick={() => deleteRelationship(selectedRelationship.id)}
              className="text-rose-400 hover:text-rose-300 disabled:opacity-40 flex items-center gap-1"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 font-mono text-[11px] text-slate-300">
            <div className="text-slate-500 text-[10px]">
              Source (Parent / Upstream):
            </div>
            <div className="text-emerald-400 font-bold">
              {project.entities[selectedRelationship.parent_entity_id]
                ?.physical_name || selectedRelationship.parent_entity_id}
            </div>
            <div className="text-slate-500 text-[10px] mt-1.5">
              Target (Child / Downstream):
            </div>
            <div className="text-sky-400 font-bold">
              {project.entities[selectedRelationship.child_entity_id]
                ?.physical_name || selectedRelationship.child_entity_id}
            </div>
          </div>

          <div>
            <label className="text-[11px] text-slate-400 block mb-1">
              Constraint / Lineage Name
            </label>
            <input
              disabled={isPhysicalLocked}
              value={selectedRelationship.name}
              onChange={(e) =>
                updateRelationship(selectedRelationship.id, {
                  name: e.target.value.toUpperCase(),
                })
              }
              className="w-full bg-slate-950 font-mono text-white px-2.5 py-1.5 rounded border border-slate-800"
            />
          </div>

          <div>
            <label className="text-[11px] text-slate-400 block mb-1">
              Relationship / Dataflow Semantics
            </label>
            <select
              disabled={isPhysicalLocked}
              value={selectedRelationship.rel_type}
              onChange={(e) =>
                updateRelationship(selectedRelationship.id, {
                  rel_type: e.target.value as RelationshipType,
                })
              }
              className="w-full bg-slate-950 text-white px-2.5 py-1.5 rounded border border-slate-800"
            >
              <option value="identifying">
                Identifying Crow&apos;s Foot (Solid — Migrates PK+FK)
              </option>
              <option value="non_identifying">
                Non-Identifying Crow&apos;s Foot (Child FK Only)
              </option>
              <option value="upstream_lineage">
                Upstream → Downstream Lineage (ETL / View Dependency)
              </option>
            </select>
          </div>

          {selectedRelationship.rel_type !== 'upstream_lineage' && (
            <div>
              <label className="text-[11px] text-slate-400 block mb-1 font-semibold">
                Relationship Enforcement (Solid vs Dashed)
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isPhysicalLocked}
                  onClick={() =>
                    updateRelationship(selectedRelationship.id, {
                      is_mandatory: true,
                      cardinality: selectedRelationship.cardinality.startsWith('0')
                        ? (selectedRelationship.cardinality === '0:1' ? '1:1' : '1:N')
                        : selectedRelationship.cardinality,
                    })
                  }
                  className={`py-2 px-2.5 rounded-lg text-xs font-bold border flex items-center justify-center gap-1.5 transition-all ${
                    selectedRelationship.is_mandatory !== false
                      ? 'bg-blue-600/30 text-blue-300 border-blue-500 shadow-sm'
                      : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white'
                  }`}
                >
                  <span className="w-3.5 h-0.5 bg-blue-400 inline-block rounded"></span>
                  <span>Mandatory (Solid)</span>
                </button>
                <button
                  type="button"
                  disabled={isPhysicalLocked}
                  onClick={() =>
                    updateRelationship(selectedRelationship.id, {
                      is_mandatory: false,
                      cardinality: selectedRelationship.cardinality.startsWith('1')
                        ? (selectedRelationship.cardinality === '1:1' ? '0:1' : '0:N')
                        : selectedRelationship.cardinality,
                    })
                  }
                  className={`py-2 px-2.5 rounded-lg text-xs font-bold border flex items-center justify-center gap-1.5 transition-all ${
                    selectedRelationship.is_mandatory === false
                      ? 'bg-amber-600/30 text-amber-300 border-amber-500 shadow-sm'
                      : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white'
                  }`}
                >
                  <span className="w-3.5 h-0.5 border-t-2 border-dashed border-amber-400 inline-block"></span>
                  <span>Optional (Dashed)</span>
                </button>
              </div>
              <p className="text-[10px] text-slate-500 mt-1">
                {selectedRelationship.is_mandatory !== false
                  ? 'Mandatory: Child records MUST reference a parent (FK is NOT NULL). Rendered as solid line.'
                  : 'Optional: Child records can exist without a parent (FK is NULLABLE). Rendered as dashed line.'}
              </p>
            </div>
          )}

          <div>
            <label className="text-[11px] text-slate-400 block mb-1">
              Cardinality (Crow&apos;s Foot Notation)
            </label>
            <select
              disabled={isPhysicalLocked}
              value={selectedRelationship.cardinality}
              onChange={(e) =>
                updateRelationship(selectedRelationship.id, {
                  cardinality: e.target.value as Cardinality,
                })
              }
              className="w-full bg-slate-950 text-white px-2.5 py-1.5 rounded border border-slate-800 font-mono"
            >
              <option value="1:N">1:N (One-to-Many Crow&apos;s Foot)</option>
              <option value="0:N">0:N (Zero-to-Many Crow&apos;s Foot)</option>
              <option value="1:1">1:1 (One-to-One)</option>
              <option value="0:1">0:1 (Zero-to-One)</option>
            </select>
          </div>

          <div>
            <label className="text-[11px] text-slate-400 block mb-1">
              Transformation / Join Rule Note
            </label>
            <textarea
              disabled={isViewer}
              rows={2}
              value={selectedRelationship.transformation_note || ''}
              onChange={(e) =>
                updateRelationship(selectedRelationship.id, {
                  transformation_note: e.target.value,
                })
              }
              placeholder="e.g. LEFT JOIN on PLCY_ID or dbt staging-to-mart lineage..."
              className="w-full bg-slate-950 text-white p-2 rounded border border-slate-800 resize-none"
            />
          </div>
        </div>
      )}

      {/* Case 2: Column Selected */}
      {selectedEntity && selectedColumn && (
        <div className="p-4 space-y-4 text-xs">
          <div className="flex items-center justify-between pb-2 border-b border-slate-800">
            <button
              type="button"
              onClick={() => selectEntity(selectedEntity.id, null)}
              className="text-[11px] text-blue-400 hover:underline"
            >
              ← Back to {selectedEntity.physical_name}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={isViewer}
                onClick={() => verifyMetadata(selectedEntity.id, selectedColumn.id)}
                className="text-emerald-400 hover:text-emerald-300 flex items-center gap-1 text-[11px]"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                Verify
              </button>
              <button
                type="button"
                disabled={isPhysicalLocked}
                onClick={() => deleteColumn(selectedEntity.id, selectedColumn.id)}
                className="text-rose-400 hover:text-rose-300 disabled:opacity-40 flex items-center gap-1 text-[11px]"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
            </div>
          </div>

          <InspectorSection id="column.basics" title="Basics" hint="name, type, keys" defaultOpen>
            {/* Logical & Physical Name Duality */}
            <div className="space-y-2.5">
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">
                  Logical Attribute Name (Business Metadata)
                </label>
                <input
                  disabled={isViewer}
                  value={selectedColumn.logical_name}
                  onChange={(e) =>
                    updateColumn(selectedEntity.id, selectedColumn.id, {
                      logical_name: e.target.value,
                    })
                  }
                  className="w-full bg-slate-950 text-white px-2.5 py-1.5 rounded border border-slate-800 focus:border-blue-500 outline-none"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] text-slate-400">
                    Physical Column Name
                  </label>
                  <button
                    type="button"
                    disabled={isPhysicalLocked}
                    onClick={() => {
                      const translated = translateLogicalToPhysicalLocal(
                        selectedColumn.logical_name,
                        project.glossary.abbreviations
                      );
                      updateColumn(selectedEntity.id, selectedColumn.id, {
                        physical_name: translated,
                      });
                    }}
                    title="Translate Logical Name to Physical Name via NSM Glossary"
                    className="text-[10px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1 disabled:opacity-40"
                  >
                    <Wand2 className="w-3 h-3" />
                    Auto-NSM
                  </button>
                </div>
                <input
                  disabled={isPhysicalLocked}
                  value={selectedColumn.physical_name}
                  onChange={(e) =>
                    updateColumn(selectedEntity.id, selectedColumn.id, {
                      physical_name: e.target.value.toUpperCase().replace(/\s+/g, '_'),
                    })
                  }
                  className="w-full bg-slate-950 font-mono text-white px-2.5 py-1.5 rounded border border-slate-800 disabled:opacity-50"
                />
              </div>

              {/* SQL Expression / Source Mapping for Views & Derived Columns */}
              <div className="p-2.5 rounded-xl bg-cyan-950/20 border border-cyan-500/30 space-y-1.5">
                <label className="text-[11px] font-semibold text-cyan-300 flex items-center gap-1.5">
                  <Code2 className="w-3.5 h-3.5" />
                  SQL Source Expression (View / Derived Column)
                </label>
                <input
                  disabled={isPhysicalLocked}
                  value={selectedColumn.source_expression || ''}
                  onChange={(e) =>
                    updateColumn(selectedEntity.id, selectedColumn.id, {
                      source_expression: e.target.value || null,
                    })
                  }
                  placeholder="e.g. SUM(FCT_CLAIM.CLM_PAID_AMT) or DIM_POLICY.PLCY_NBR"
                  className="w-full bg-slate-950 font-mono text-[11px] text-cyan-100 px-2 py-1.5 rounded border border-slate-800"
                />
              </div>
            </div>

            {/* Multi-Dialect Physical Data Types */}
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2.5">
              <div className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5 text-sky-400" />
                Multi-Dialect Data Types &amp; Constraints
              </div>

              <div>
                <label className="text-[10px] text-sky-400 font-mono block mb-0.5">
                  Snowflake Data Type
                </label>
                <input
                  disabled={isPhysicalLocked}
                  value={selectedColumn.data_type_snowflake}
                  onChange={(e) =>
                    updateColumn(selectedEntity.id, selectedColumn.id, {
                      data_type_snowflake: e.target.value.toUpperCase(),
                    })
                  }
                  className="w-full bg-slate-900 font-mono text-white px-2 py-1 rounded border border-slate-800"
                />
              </div>

              <div>
                <label className="text-[10px] text-emerald-400 font-mono block mb-0.5">
                  SQL Server (T-SQL) Data Type
                </label>
                <input
                  disabled={isPhysicalLocked}
                  value={selectedColumn.data_type_sql_server}
                  onChange={(e) =>
                    updateColumn(selectedEntity.id, selectedColumn.id, {
                      data_type_sql_server: e.target.value.toUpperCase(),
                    })
                  }
                  className="w-full bg-slate-900 font-mono text-white px-2 py-1 rounded border border-slate-800"
                />
              </div>

              <div>
                <label className="text-[10px] text-amber-400 font-mono block mb-0.5">
                  Oracle (PL/SQL) Data Type
                </label>
                <input
                  disabled={isPhysicalLocked}
                  value={selectedColumn.data_type_oracle}
                  onChange={(e) =>
                    updateColumn(selectedEntity.id, selectedColumn.id, {
                      data_type_oracle: e.target.value.toUpperCase(),
                    })
                  }
                  className="w-full bg-slate-900 font-mono text-white px-2 py-1 rounded border border-slate-800"
                />
              </div>

              <div>
                <label className="text-[10px] text-slate-400 font-mono block mb-0.5">
                  SQL CHECK Constraint Expression
                </label>
                <input
                  disabled={isPhysicalLocked}
                  value={selectedColumn.check_constraint || ''}
                  onChange={(e) =>
                    updateColumn(selectedEntity.id, selectedColumn.id, {
                      check_constraint: e.target.value || null,
                    })
                  }
                  placeholder={`e.g. ${selectedColumn.physical_name} >= 0`}
                  className="w-full bg-slate-900 font-mono text-white px-2 py-1 rounded border border-slate-800"
                />
              </div>
            </div>

            {/* Keys & Constraints */}
            <div className="grid grid-cols-2 gap-2 p-3 rounded-xl bg-slate-950 border border-slate-800">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={isPhysicalLocked}
                  checked={selectedColumn.is_pk}
                  onChange={(e) =>
                    updateColumn(selectedEntity.id, selectedColumn.id, {
                      is_pk: e.target.checked,
                      is_nullable: e.target.checked ? false : selectedColumn.is_nullable,
                    })
                  }
                  className="rounded accent-amber-500"
                />
                <span className="flex items-center gap-1 text-amber-300 font-medium">
                  <Key className="w-3 h-3" /> Primary Key
                </span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={isPhysicalLocked}
                  checked={selectedColumn.is_fk}
                  onChange={(e) =>
                    updateColumn(selectedEntity.id, selectedColumn.id, {
                      is_fk: e.target.checked,
                    })
                  }
                  className="rounded accent-sky-500"
                />
                <span className="flex items-center gap-1 text-sky-300 font-medium">
                  <Link2 className="w-3 h-3" /> Foreign Key
                </span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={isPhysicalLocked}
                  checked={Boolean(selectedColumn.is_ak)}
                  onChange={(e) =>
                    updateColumn(selectedEntity.id, selectedColumn.id, {
                      is_ak: e.target.checked,
                      is_unique: e.target.checked ? true : selectedColumn.is_unique,
                    })
                  }
                  className="rounded accent-violet-500"
                />
                <span className="text-violet-300 font-medium">
                  Alternate Key (AK)
                </span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={isPhysicalLocked || selectedColumn.is_pk}
                  checked={selectedColumn.is_nullable}
                  onChange={(e) =>
                    updateColumn(selectedEntity.id, selectedColumn.id, {
                      is_nullable: e.target.checked,
                    })
                  }
                  className="rounded accent-blue-500"
                />
                <span className="text-slate-300">Nullable</span>
              </label>
            </div>
          </InspectorSection>

          <InspectorSection id="column.governance" title="Governance" hint="domain, PII">
            {/* Enterprise Domain Binding */}
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
              <label className="text-[11px] font-semibold text-violet-300 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" />
                Enterprise Domain
              </label>
              <select
                disabled={isPhysicalLocked}
                value={selectedColumn.domain_id || ''}
                onChange={(e) =>
                  updateColumn(selectedEntity.id, selectedColumn.id, {
                    domain_id: e.target.value || null,
                  })
                }
                className="w-full bg-slate-900 text-white px-2.5 py-1.5 rounded border border-slate-700"
              >
                <option value="">-- Custom / Unbound --</option>
                {Object.values(project.domains).map((dom) => (
                  <option key={dom.id} value={dom.id}>
                    {dom.name} ({dom.snowflake_type})
                  </option>
                ))}
              </select>
            </div>

            {/* Governance & PII Classification (Editable by Data Steward!) */}
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2.5">
              <label className="text-[11px] font-semibold text-rose-300 flex items-center gap-1.5">
                <ShieldAlert className="w-3.5 h-3.5" />
                PII &amp; Dynamic Data Masking
              </label>
              <select
                disabled={isViewer}
                value={selectedColumn.pii_classification}
                onChange={(e) =>
                  updateColumn(selectedEntity.id, selectedColumn.id, {
                    pii_classification: e.target.value as PiiClassification,
                  })
                }
                className="w-full bg-slate-900 text-white px-2.5 py-1.5 rounded border border-slate-700"
              >
                <option value="NONE">NONE (Public / Non-Sensitive)</option>
                <option value="INTERNAL">INTERNAL (Enterprise Operational)</option>
                <option value="CONFIDENTIAL">CONFIDENTIAL (Financial / Commercial)</option>
                <option value="RESTRICTED_PII">
                  RESTRICTED_PII (Auto-Compiles Dynamic Masking Policy)
                </option>
              </select>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] text-slate-400">
                    Business Definition ({selectedColumn.metadata_status || 'DRAFT'})
                  </label>
                  <button
                    type="button"
                    disabled={isViewer || isGeneratingMetadata}
                    onClick={() => autoGenerateMetadata(selectedEntity.id)}
                    className="text-[10px] text-violet-400 hover:underline flex items-center gap-1 disabled:opacity-50"
                  >
                    {isGeneratingMetadata ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin text-violet-400" />
                        <span>AI Defining...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3 h-3" />
                        <span>AI Auto-Define</span>
                      </>
                    )}
                  </button>
                </div>
                <textarea
                  disabled={isViewer}
                  rows={3}
                  value={selectedColumn.description}
                  onChange={(e) =>
                    updateColumn(selectedEntity.id, selectedColumn.id, {
                      description: e.target.value,
                    })
                  }
                  placeholder="Document business semantics..."
                  className="w-full bg-slate-900 text-white p-2 rounded border border-slate-700 resize-none"
                />
              </div>
            </div>
          </InspectorSection>

          <InspectorSection id="column.advanced" title="Advanced" hint="profiling, lineage">
            {/* DATA PROFILING & STATISTICAL DISTRIBUTION CARD */}
            <div className="p-3 rounded-xl bg-slate-950 border border-emerald-500/30 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-emerald-400 flex items-center gap-1.5">
                  <BarChart3 className="w-3.5 h-3.5" />
                  Column Data Profile &amp; DQ
                </span>
                <button
                  type="button"
                  onClick={() => runDataProfiler(selectedEntity.id)}
                  className="text-[10px] text-emerald-300 hover:underline"
                >
                  Re-Profile
                </button>
              </div>

              {selectedColumn.profile ? (
                <div className="space-y-2 text-[11px]">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-slate-900 p-2 rounded border border-slate-800">
                      <div className="text-[10px] text-slate-400">Null Ratio</div>
                      <div className="font-mono font-bold text-white">
                        {selectedColumn.profile.null_pct}%
                      </div>
                      <div className="w-full h-1.5 bg-slate-800 rounded-full mt-1 overflow-hidden">
                        <div
                          style={{
                            width: `${Math.min(
                              100,
                              100 - selectedColumn.profile.null_pct
                            )}%`,
                          }}
                          className="h-full bg-emerald-500"
                        />
                      </div>
                    </div>
                    <div className="bg-slate-900 p-2 rounded border border-slate-800">
                      <div className="text-[10px] text-slate-400">
                        Distinct / Uniqueness
                      </div>
                      <div className="font-mono font-bold text-sky-300">
                        {selectedColumn.profile.distinct_count.toLocaleString()} (
                        {selectedColumn.profile.uniqueness_pct}%)
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 font-mono text-[10px] bg-slate-900 p-2 rounded border border-slate-800">
                    <div>
                      <span className="text-slate-500">Min:</span>{' '}
                      <span className="text-slate-200">
                        {selectedColumn.profile.min_value || 'N/A'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500">Max:</span>{' '}
                      <span className="text-slate-200">
                        {selectedColumn.profile.max_value || 'N/A'}
                      </span>
                    </div>
                  </div>

                  {selectedColumn.profile.sample_values.length > 0 && (
                    <div>
                      <div className="text-[10px] text-slate-400 mb-1">
                        Top Sample / Frequency Values:
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {selectedColumn.profile.sample_values.map((sv) => (
                          <span
                            key={sv}
                            className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 font-mono text-[10px] text-slate-300"
                          >
                            {sv}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedColumn.profile.recommended_tests.length > 0 && (
                    <div className="pt-1 border-t border-slate-800/80 flex items-center justify-between gap-2">
                      <span className="text-[10px] text-amber-300 font-mono truncate">
                        Rec: {selectedColumn.profile.recommended_tests.join(', ')}
                      </span>
                      <button
                        type="button"
                        disabled={isPhysicalLocked}
                        onClick={() => applyRecommendedDq(selectedEntity.id)}
                        className="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-semibold shrink-0"
                      >
                        Apply DQ
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => runDataProfiler(selectedEntity.id)}
                  className="w-full py-1.5 rounded bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 font-semibold text-xs"
                >
                  Run Column Data Profiler
                </button>
              )}
            </div>

            {/* COLUMN-LEVEL LINEAGE & BLAST-RADIUS IMPACT ANALYSIS */}
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
              <div className="text-[11px] font-bold text-amber-400 flex items-center gap-1.5">
                <GitBranch className="w-3.5 h-3.5" />
                Column-Level Lineage &amp; Blast Radius
              </div>
              <div className="text-[10px] text-slate-400">
                Upstream Source Columns ({colUpstreamSources.length}):
              </div>
              {colUpstreamSources.length === 0 ? (
                <div className="text-[10px] text-slate-600 italic pl-1">
                  Origin / Base Attribute
                </div>
              ) : (
                colUpstreamSources.map((u, i) => (
                  <div
                    key={`${u.entityId}-${i}`}
                    onClick={() => selectEntity(u.entityId, null)}
                    className="px-2 py-1 rounded bg-slate-900 border border-slate-800 font-mono text-[10px] text-emerald-300 cursor-pointer hover:bg-slate-800"
                  >
                    ↑ {u.entityName}.{u.colName}
                  </div>
                ))
              )}

              <div className="text-[10px] text-slate-400 pt-1">
                Downstream Dependent Columns ({colDownstreamDependents.length}):
              </div>
              {colDownstreamDependents.length === 0 ? (
                <div className="text-[10px] text-slate-600 italic pl-1">
                  No downstream column dependencies
                </div>
              ) : (
                <>
                  <div className="px-2 py-1 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[10px] flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3 shrink-0" />
                    <span>
                      Altering or dropping this column impacts{' '}
                      {colDownstreamDependents.length} downstream object(s):
                    </span>
                  </div>
                  {colDownstreamDependents.map((d, i) => (
                    <div
                      key={`${d.entityId}-${i}`}
                      onClick={() => selectEntity(d.entityId, null)}
                      className="px-2 py-1 rounded bg-slate-900 border border-slate-800 font-mono text-[10px] text-sky-300 cursor-pointer hover:bg-slate-800"
                    >
                      ↓ {d.entityName}.{d.colName}
                    </div>
                  ))}
                </>
              )}
            </div>
          </InspectorSection>
        </div>
      )}

      {/* Case 3: Entity Selected (No specific column active) */}
      {selectedEntity && !selectedColumn && (
        <div className="p-4 space-y-4 text-xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-bold text-blue-400 uppercase tracking-wider text-[11px]">
                {selectedEntity.entity_type === 'table'
                  ? 'Table Definition'
                  : 'SQL View Definition'}
              </span>
              {selectedEntity.metadata_status === 'AUTO_GENERATED' && (
                <span className="px-1.5 py-0.5 rounded text-[9px] bg-violet-950/80 border border-violet-500/50 text-violet-300 font-medium flex items-center gap-1">
                  <Sparkles className="w-2.5 h-2.5" />
                  AI Defined
                </span>
              )}
            </div>
            <button
              type="button"
              disabled={isPhysicalLocked}
              onClick={() => deleteEntity(selectedEntity.id)}
              className="text-rose-400 hover:text-rose-300 disabled:opacity-40 flex items-center gap-1 text-[11px]"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Drop Object
            </button>
          </div>

          {/* 1-Click AI Auto-Metadata, Profiler & Steward Verify Action Bar */}
          <div className="grid grid-cols-3 gap-1.5">
            <button
              type="button"
              disabled={isViewer || isGeneratingMetadata}
              onClick={() => autoGenerateMetadata(selectedEntity.id)}
              title="Auto-generate business descriptions, grain statement, PII classifications, and retention policy"
              className="py-1.5 px-2 rounded-lg bg-violet-600/20 hover:bg-violet-600/30 text-violet-300 border border-violet-500/30 font-semibold text-[11px] flex items-center justify-center gap-1 disabled:opacity-50 transition-all"
            >
              {isGeneratingMetadata ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin text-violet-400" />
                  <span>Generating...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3 h-3" />
                  <span>Auto-Meta</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => runDataProfiler(selectedEntity.id)}
              title="Run statistical column profiler & volumetric estimator"
              className="py-1.5 px-2 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 font-semibold text-[11px] flex items-center justify-center gap-1"
            >
              <BarChart3 className="w-3 h-3" />
              <span>Profile</span>
            </button>
            <button
              type="button"
              disabled={isViewer}
              onClick={() => verifyMetadata(selectedEntity.id, null)}
              title="Approve & mark entity and column definitions as STEWARD_VERIFIED"
              className="py-1.5 px-2 rounded-lg bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/30 font-semibold text-[11px] flex items-center justify-center gap-1"
            >
              <CheckCircle2 className="w-3 h-3" />
              <span>Verify</span>
            </button>
          </div>

          <InspectorSection id="entity.basics" title="Basics" hint="name, description, type" defaultOpen>
            <div>
              <label className="text-[11px] text-slate-400 block mb-1">
                Logical Entity Name (Business Term)
              </label>
              <input
                disabled={isViewer}
                value={selectedEntity.logical_name}
                onChange={(e) =>
                  updateEntity(selectedEntity.id, { logical_name: e.target.value })
                }
                className="w-full bg-slate-950 text-white px-2.5 py-1.5 rounded border border-slate-800"
              />
            </div>

            <div>
              <label className="text-[11px] text-slate-400 block mb-1">
                Physical Name
              </label>
              <input
                disabled={isPhysicalLocked}
                value={selectedEntity.physical_name}
                onChange={(e) =>
                  updateEntity(selectedEntity.id, {
                    physical_name: e.target.value.toUpperCase().replace(/\s+/g, '_'),
                  })
                }
                className="w-full bg-slate-950 font-mono text-white px-2.5 py-1.5 rounded border border-slate-800"
              />
            </div>

            <div>
              <label className="text-[11px] text-slate-400 block mb-1">
                Business Description ({selectedEntity.metadata_status || 'DRAFT'})
              </label>
              <textarea
                disabled={isViewer}
                rows={2}
                value={selectedEntity.description}
                onChange={(e) =>
                  updateEntity(selectedEntity.id, { description: e.target.value })
                }
                className="w-full bg-slate-950 text-white p-2 rounded border border-slate-800 resize-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">
                  Object Type
                </label>
                <select
                  disabled={isPhysicalLocked}
                  value={selectedEntity.entity_type || 'table'}
                  onChange={(e) => {
                    const nextType = e.target.value as EntityObjectType;
                    const patch: Partial<typeof selectedEntity> = {
                      entity_type: nextType,
                      dbt_materialization:
                        nextType === 'view' ? 'view' : 'table',
                    };
                    if (nextType !== 'table' && !selectedEntity.view_sql) {
                      patch.view_sql = synthesizeViewSqlLocal(
                        { ...selectedEntity, entity_type: nextType },
                        project
                      );
                    }
                    updateEntity(selectedEntity.id, patch);
                  }}
                  className="w-full bg-slate-950 text-cyan-300 font-semibold px-2 py-1.5 rounded border border-slate-800"
                >
                  <option value="table">Physical Table</option>
                  <option value="view">SQL View</option>
                  <option value="materialized_view">Materialized View</option>
                </select>
              </div>

              <div>
                <label className="text-[11px] text-slate-400 block mb-1">
                  Modeling Stereotype
                </label>
                <select
                  disabled={isPhysicalLocked}
                  value={selectedEntity.modeling_stereotype || 'DIM_SCD1'}
                  onChange={(e) =>
                    updateEntity(selectedEntity.id, {
                      modeling_stereotype: e.target.value as ModelingStereotype,
                    })
                  }
                  className="w-full bg-slate-950 text-amber-300 font-semibold px-2 py-1.5 rounded border border-slate-800"
                >
                  <option value="DIM_SCD1">Dimension (SCD Type 1)</option>
                  <option value="DIM_SCD2">Dimension (SCD Type 2)</option>
                  <option value="FCT_TRANSACTION">Fact (Transaction)</option>
                  <option value="FCT_SNAPSHOT">Fact (Periodic Snapshot)</option>
                  <option value="VAULT_HUB">Data Vault Hub</option>
                  <option value="VAULT_LINK">Data Vault Link</option>
                  <option value="VAULT_SATELLITE">Data Vault Satellite</option>
                  <option value="ODS_STAGING">Staging / ODS</option>
                  <option value="ANALYTICAL_VIEW">Analytical View</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">
                  Subject Area
                </label>
                <select
                  disabled={isPhysicalLocked}
                  value={selectedEntity.subject_area}
                  onChange={(e) =>
                    updateEntity(selectedEntity.id, { subject_area: e.target.value })
                  }
                  className="w-full bg-slate-950 text-white px-2 py-1.5 rounded border border-slate-800"
                >
                  {project.subject_areas.map((sa) => (
                    <option key={sa} value={sa}>
                      {sa}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">
                  Database Schema
                </label>
                <input
                  disabled={isPhysicalLocked}
                  value={selectedEntity.database_schema}
                  onChange={(e) =>
                    updateEntity(selectedEntity.id, {
                      database_schema: e.target.value.toUpperCase(),
                    })
                  }
                  className="w-full bg-slate-950 font-mono text-white px-2 py-1.5 rounded border border-slate-800"
                />
              </div>
            </div>

            {/* Header Color Swatches */}
            <div>
              <label className="text-[11px] text-slate-400 block mb-1.5">
                Header Color Coding
              </label>
              <div className="flex items-center gap-1.5">
                {COLOR_SWATCHES.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    onClick={() =>
                      updateEntity(selectedEntity.id, { header_color: hex })
                    }
                    style={{ backgroundColor: hex }}
                    className={`w-5 h-5 rounded-full border transition-transform ${
                      selectedEntity.header_color === hex
                        ? 'scale-125 border-white ring-2 ring-white/30'
                        : 'border-transparent opacity-80 hover:opacity-100'
                    }`}
                  />
                ))}
              </div>
            </div>
          </InspectorSection>

          {/* Quick Column Selector */}
          <div className="pt-2 border-t border-slate-800">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Columns ({selectedEntity.columns.length})
              </span>
              <button
                type="button"
                disabled={isPhysicalLocked}
                onClick={() => addColumn(selectedEntity.id)}
                className="text-blue-400 hover:text-blue-300 font-semibold text-[11px] disabled:opacity-40"
              >
                + Add Column
              </button>
            </div>
            <div className="space-y-1">
              {selectedEntity.columns.map((col) => (
                <button
                  key={col.id}
                  type="button"
                  onClick={() => selectEntity(selectedEntity.id, col.id)}
                  className="w-full text-left px-2.5 py-1.5 rounded bg-slate-950 hover:bg-slate-800 border border-slate-800/80 flex items-center justify-between"
                >
                  <span className="font-mono text-[11px] text-slate-200 truncate">
                    {col.physical_name}
                  </span>
                  <span className="text-[10px] font-mono text-slate-400">
                    {col.data_type_snowflake}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <InspectorSection id="entity.modeling" title="Modeling" hint="grain, patterns, lineage">
            <div>
              <label className="text-[11px] text-amber-300/90 block mb-1">
                Table Grain Statement (Kimball Standard)
              </label>
              <input
                disabled={isViewer}
                value={selectedEntity.grain_statement || ''}
                onChange={(e) =>
                  updateEntity(selectedEntity.id, {
                    grain_statement: e.target.value,
                  })
                }
                placeholder="e.g. One atomic row per Insurance Claim transaction"
                className="w-full bg-slate-950 text-white px-2.5 py-1.5 rounded border border-slate-800"
              />
            </div>

            {/* 1-Click Kimball / Data Vault Pattern Macro Buttons */}
            {!isPhysicalLocked && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                <button
                  type="button"
                  onClick={() =>
                    applyModelingPattern(selectedEntity.id, 'SCD_TYPE_2')
                  }
                  className="px-2 py-1 rounded bg-slate-950 hover:bg-slate-800 text-amber-300 border border-slate-800 text-[10px] font-mono"
                >
                  + Inject SCD2 Cols
                </button>
                <button
                  type="button"
                  onClick={() =>
                    applyModelingPattern(selectedEntity.id, 'DATA_VAULT_HUB')
                  }
                  className="px-2 py-1 rounded bg-slate-950 hover:bg-slate-800 text-cyan-300 border border-slate-800 text-[10px] font-mono"
                >
                  + Vault Hub Cols
                </button>
                <button
                  type="button"
                  onClick={() =>
                    applyModelingPattern(selectedEntity.id, 'ENTERPRISE_AUDIT')
                  }
                  className="px-2 py-1 rounded bg-slate-950 hover:bg-slate-800 text-emerald-300 border border-slate-800 text-[10px] font-mono"
                >
                  + Audit Cols
                </button>
              </div>
            )}

            {/* VIEW SQL SYNTHESIS PANEL (When entity is a View / Materialized View) */}
            {(selectedEntity.entity_type === 'view' ||
              selectedEntity.entity_type === 'materialized_view') && (
              <div className="p-3 rounded-xl bg-cyan-950/25 border border-cyan-500/40 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-cyan-300 flex items-center gap-1.5">
                    <Code2 className="w-3.5 h-3.5" />
                    Background View SQL Builder
                  </span>
                  <button
                    type="button"
                    disabled={isPhysicalLocked}
                    onClick={() => {
                      const autoSql = synthesizeViewSqlLocal(
                        { ...selectedEntity, view_sql: null },
                        project
                      );
                      updateEntity(selectedEntity.id, { view_sql: autoSql });
                    }}
                    className="text-[10px] text-cyan-400 hover:underline"
                  >
                    Re-Synthesize SQL
                  </button>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] text-slate-300 block">
                    Pull Columns &amp; Wire Upstream Table into View:
                  </label>
                  <div className="flex items-center gap-1.5">
                    <select
                      value={upstreamImportId}
                      onChange={(e) => setUpstreamImportId(e.target.value)}
                      className="flex-1 bg-slate-950 text-white px-2 py-1 rounded border border-slate-700 text-[11px]"
                    >
                      <option value="">-- Select Source Table --</option>
                      {otherEntities.map((oe) => (
                        <option key={oe.id} value={oe.id}>
                          {oe.physical_name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={!upstreamImportId || isPhysicalLocked}
                      onClick={() => {
                        if (!upstreamImportId) return;
                        importColumnsFromUpstream(
                          selectedEntity.id,
                          upstreamImportId
                        );
                      }}
                      className="px-2.5 py-1 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white font-semibold text-[11px] flex items-center gap-1 shrink-0"
                    >
                      <Plus className="w-3 h-3" />
                      Import
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-[10px] text-cyan-300 font-mono block mb-1">
                    Generated SELECT Body (Compiled into CREATE OR REPLACE VIEW):
                  </label>
                  <textarea
                    disabled={isPhysicalLocked}
                    rows={6}
                    value={
                      selectedEntity.view_sql ||
                      synthesizeViewSqlLocal(selectedEntity, project)
                    }
                    onChange={(e) =>
                      updateEntity(selectedEntity.id, { view_sql: e.target.value })
                    }
                    className="w-full bg-slate-950 font-mono text-[11px] text-cyan-100 p-2 rounded border border-slate-800 resize-y"
                  />
                </div>
              </div>
            )}

            {/* UPSTREAM & DOWNSTREAM LINEAGE + PARENT/CHILD RELATIONS */}
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2.5">
              <div className="text-[11px] font-bold text-amber-400 flex items-center gap-1.5">
                <GitBranch className="w-3.5 h-3.5" />
                Upstream &amp; Downstream Relations
              </div>

              <div className="space-y-1">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1">
                  <ArrowUpRight className="w-3 h-3 text-emerald-400" />
                  Upstream / Parent Sources ({upstreamRels.length})
                </div>
                {upstreamRels.length === 0 ? (
                  <div className="text-[11px] text-slate-600 italic pl-2">
                    No upstream sources or parent tables
                  </div>
                ) : (
                  upstreamRels.map((r) => {
                    const upEnt = project.entities[r.parent_entity_id];
                    return (
                      <div
                        key={r.id}
                        onClick={() => upEnt && selectEntity(upEnt.id, null)}
                        className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 flex items-center justify-between cursor-pointer"
                      >
                        <span className="font-mono text-[11px] text-emerald-300 truncate">
                          {upEnt?.physical_name || r.parent_entity_id}
                        </span>
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-slate-950 text-slate-400">
                          {r.rel_type === 'upstream_lineage'
                            ? 'LINEAGE'
                            : `FK (${r.cardinality})`}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="space-y-1 pt-1">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1">
                  <ArrowDownRight className="w-3 h-3 text-sky-400" />
                  Downstream / Child Targets ({downstreamRels.length})
                </div>
                {downstreamRels.length === 0 ? (
                  <div className="text-[11px] text-slate-600 italic pl-2">
                    No downstream views or child tables
                  </div>
                ) : (
                  downstreamRels.map((r) => {
                    const downEnt = project.entities[r.child_entity_id];
                    return (
                      <div
                        key={r.id}
                        onClick={() => downEnt && selectEntity(downEnt.id, null)}
                        className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 flex items-center justify-between cursor-pointer"
                      >
                        <span className="font-mono text-[11px] text-sky-300 truncate">
                          {downEnt?.physical_name || r.child_entity_id}
                        </span>
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-slate-950 text-slate-400">
                          {r.rel_type === 'upstream_lineage'
                            ? 'LINEAGE'
                            : `FK (${r.cardinality})`}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="pt-2 border-t border-slate-800/80 space-y-1.5">
                <div className="text-[10px] text-slate-400 font-semibold">
                  + Add Upstream / Downstream or Crow&apos;s Foot Link:
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <select
                    value={newRelDirection}
                    onChange={(e) =>
                      setNewRelDirection(
                        e.target.value as 'downstream' | 'upstream'
                      )
                    }
                    className="bg-slate-900 text-white px-2 py-1 rounded border border-slate-700 text-[11px]"
                  >
                    <option value="downstream">This → Downstream/Child</option>
                    <option value="upstream">Upstream/Parent → This</option>
                  </select>
                  <select
                    value={newRelType}
                    onChange={(e) =>
                      setNewRelType(e.target.value as RelationshipType)
                    }
                    className="bg-slate-900 text-white px-2 py-1 rounded border border-slate-700 text-[11px]"
                  >
                    <option value="upstream_lineage">Lineage (Up → Down)</option>
                    <option value="non_identifying">Crow&apos;s Foot FK</option>
                    <option value="identifying">Identifying PK+FK</option>
                  </select>
                </div>
                <div className="flex items-center gap-1.5">
                  <select
                    value={newRelTargetId}
                    onChange={(e) => setNewRelTargetId(e.target.value)}
                    className="flex-1 bg-slate-900 text-white px-2 py-1 rounded border border-slate-700 text-[11px]"
                  >
                    <option value="">-- Select Counterpart Entity --</option>
                    {otherEntities.map((oe) => (
                      <option key={oe.id} value={oe.id}>
                        {oe.physical_name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!newRelTargetId || isPhysicalLocked}
                    onClick={() => {
                      if (!newRelTargetId) return;
                      if (newRelDirection === 'downstream') {
                        connectEntitiesWithRelationship(
                          selectedEntity.id,
                          newRelTargetId,
                          null,
                          null,
                          newRelType
                        );
                      } else {
                        connectEntitiesWithRelationship(
                          newRelTargetId,
                          selectedEntity.id,
                          null,
                          null,
                          newRelType
                        );
                      }
                    }}
                    className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-semibold text-[11px] shrink-0"
                  >
                    Link
                  </button>
                </div>
              </div>
            </div>
          </InspectorSection>

          <InspectorSection id="entity.governance" title="Governance" hint="retention, contract">
            {/* DATA LIFECYCLE, REGULATORY RETENTION & ARCHIVAL POLICY */}
            <div className="p-3 rounded-xl bg-slate-950 border border-indigo-500/30 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-indigo-300 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" />
                  Data Retention &amp; Lifecycle Policy
                </span>
                <label className="flex items-center gap-1 text-[10px] text-rose-300 cursor-pointer font-semibold">
                  <input
                    type="checkbox"
                    disabled={isViewer}
                    checked={retention.legal_hold}
                    onChange={(e) =>
                      updateEntity(selectedEntity.id, {
                        retention_policy: {
                          ...retention,
                          legal_hold: e.target.checked,
                        },
                      })
                    }
                    className="rounded accent-rose-500"
                  />
                  <span>Legal Hold</span>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-slate-400 block mb-0.5">
                    Regulatory Framework
                  </label>
                  <select
                    disabled={isViewer}
                    value={retention.regulatory_framework}
                    onChange={(e) =>
                      updateEntity(selectedEntity.id, {
                        retention_policy: {
                          ...retention,
                          regulatory_framework: e.target
                            .value as RegulatoryFramework,
                        },
                      })
                    }
                    className="w-full bg-slate-900 text-white px-2 py-1 rounded border border-slate-800 text-[11px]"
                  >
                    <option value="NONE">NONE (Standard)</option>
                    <option value="SOX_7YR">SOX 7-Year Financial</option>
                    <option value="GDPR">GDPR Privacy Right-to-Erasure</option>
                    <option value="HIPAA">HIPAA 6-Year Clinical</option>
                    <option value="CCPA">CCPA Consumer Privacy</option>
                    <option value="PCI_DSS">PCI-DSS Cardholder</option>
                  </select>
                </div>

                <div>
                  <label className="text-[10px] text-slate-400 block mb-0.5">
                    Disposition Action
                  </label>
                  <select
                    disabled={isViewer}
                    value={retention.disposition_action}
                    onChange={(e) =>
                      updateEntity(selectedEntity.id, {
                        retention_policy: {
                          ...retention,
                          disposition_action: e.target.value as DispositionAction,
                        },
                      })
                    }
                    className="w-full bg-slate-900 text-white px-2 py-1 rounded border border-slate-800 text-[11px]"
                  >
                    <option value="ARCHIVE_TO_COLD_STORAGE">
                      Archive to Cold Tier
                    </option>
                    <option value="PURGE_HARD_DELETE">Purge / Hard Delete</option>
                    <option value="ANONYMIZE_PII">Anonymize / Mask PII</option>
                    <option value="KEEP_INDEFINITELY">Keep Indefinitely</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-slate-400 block mb-0.5">
                    Hot Active Tier (Days)
                  </label>
                  <input
                    type="number"
                    disabled={isViewer}
                    value={retention.active_retention_days}
                    onChange={(e) =>
                      updateEntity(selectedEntity.id, {
                        retention_policy: {
                          ...retention,
                          active_retention_days: Number(e.target.value) || 0,
                        },
                      })
                    }
                    className="w-full bg-slate-900 font-mono text-white px-2 py-1 rounded border border-slate-800"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-slate-400 block mb-0.5">
                    Cold Archive Tier (Days)
                  </label>
                  <input
                    type="number"
                    disabled={isViewer}
                    value={retention.archive_retention_days}
                    onChange={(e) =>
                      updateEntity(selectedEntity.id, {
                        retention_policy: {
                          ...retention,
                          archive_retention_days: Number(e.target.value) || 0,
                        },
                      })
                    }
                    className="w-full bg-slate-900 font-mono text-white px-2 py-1 rounded border border-slate-800"
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] text-slate-400 block mb-0.5">
                  Retention Date Driver Column (Compiles Purge/Archive SQL Task)
                </label>
                <select
                  disabled={isViewer}
                  value={retention.retention_date_column || ''}
                  onChange={(e) =>
                    updateEntity(selectedEntity.id, {
                      retention_policy: {
                        ...retention,
                        retention_date_column: e.target.value || null,
                      },
                    })
                  }
                  className="w-full bg-slate-900 font-mono text-white px-2 py-1 rounded border border-slate-800 text-[11px]"
                >
                  <option value="">-- Select Date/Timestamp Column --</option>
                  {selectedEntity.columns.map((c) => (
                    <option key={c.id} value={c.physical_name}>
                      {c.physical_name} ({c.data_type_snowflake})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* OPEN DATA CONTRACT & OPERATIONAL SLAs (ODCS v2) */}
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
              <div className="text-[11px] font-bold text-sky-300 flex items-center gap-1.5">
                <FileCheck2 className="w-3.5 h-3.5" />
                Open Data Contract &amp; SLA (ODCS)
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-slate-400 block mb-0.5">
                    Domain Data Owner
                  </label>
                  <input
                    disabled={isViewer}
                    value={contract.data_owner}
                    onChange={(e) =>
                      updateEntity(selectedEntity.id, {
                        data_contract: { ...contract, data_owner: e.target.value },
                      })
                    }
                    className="w-full bg-slate-900 text-white px-2 py-1 rounded border border-slate-800 text-[11px]"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-slate-400 block mb-0.5">
                    Criticality Tier
                  </label>
                  <select
                    disabled={isViewer}
                    value={contract.tier}
                    onChange={(e) =>
                      updateEntity(selectedEntity.id, {
                        data_contract: {
                          ...contract,
                          tier: e.target.value as DataContractSLA['tier'],
                        },
                      })
                    }
                    className="w-full bg-slate-900 text-white px-2 py-1 rounded border border-slate-800 text-[11px]"
                  >
                    <option value="Tier-1 Mission Critical">
                      Tier-1 Mission Critical
                    </option>
                    <option value="Tier-2 Operational">Tier-2 Operational</option>
                    <option value="Tier-3 Self-Service">Tier-3 Self-Service</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-slate-400 block mb-0.5">
                    Freshness SLA (Hours)
                  </label>
                  <input
                    type="number"
                    disabled={isViewer}
                    value={contract.freshness_sla_hours}
                    onChange={(e) =>
                      updateEntity(selectedEntity.id, {
                        data_contract: {
                          ...contract,
                          freshness_sla_hours: Number(e.target.value) || 24,
                        },
                      })
                    }
                    className="w-full bg-slate-900 font-mono text-white px-2 py-1 rounded border border-slate-800"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-slate-400 block mb-0.5">
                    Completeness SLA (%)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    disabled={isViewer}
                    value={contract.completeness_sla_pct}
                    onChange={(e) =>
                      updateEntity(selectedEntity.id, {
                        data_contract: {
                          ...contract,
                          completeness_sla_pct: Number(e.target.value) || 99.0,
                        },
                      })
                    }
                    className="w-full bg-slate-900 font-mono text-white px-2 py-1 rounded border border-slate-800"
                  />
                </div>
              </div>
            </div>
          </InspectorSection>

          <InspectorSection id="entity.advanced" title="Advanced" hint="storage, dbt, volumetrics">
            {/* Dialect-Specific Physical Storage Modeling */}
            {selectedEntity.entity_type === 'table' && (
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
                <div className="text-[11px] font-bold text-sky-400 flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5" />
                  Physical Storage ({targetDialect.toUpperCase()})
                </div>

                {targetDialect === 'snowflake' && (
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        disabled={isPhysicalLocked}
                        checked={selectedEntity.snowflake_props.transient}
                        onChange={(e) =>
                          updateEntity(selectedEntity.id, {
                            snowflake_props: {
                              ...selectedEntity.snowflake_props,
                              transient: e.target.checked,
                            },
                          })
                        }
                        className="rounded accent-sky-500"
                      />
                      <span className="text-slate-300">TRANSIENT Table</span>
                    </label>

                    <div>
                      <label className="text-[10px] text-slate-400 block mb-0.5">
                        CLUSTER BY Columns (comma-separated)
                      </label>
                      <input
                        disabled={isPhysicalLocked}
                        value={selectedEntity.snowflake_props.cluster_by.join(', ')}
                        onChange={(e) =>
                          updateEntity(selectedEntity.id, {
                            snowflake_props: {
                              ...selectedEntity.snowflake_props,
                              cluster_by: e.target.value
                                .split(',')
                                .map((s) => s.trim().toUpperCase())
                                .filter(Boolean),
                            },
                          })
                        }
                        placeholder="e.g. CLM_INCURRED_DT, PLCY_ID"
                        className="w-full bg-slate-900 font-mono text-white px-2 py-1 rounded border border-slate-800"
                      />
                    </div>

                    <div>
                      <label className="text-[10px] text-slate-400 block mb-0.5">
                        DATA_RETENTION_TIME_IN_DAYS (Time Travel)
                      </label>
                      <input
                        type="number"
                        disabled={isPhysicalLocked}
                        value={selectedEntity.snowflake_props.data_retention_days}
                        onChange={(e) =>
                          updateEntity(selectedEntity.id, {
                            snowflake_props: {
                              ...selectedEntity.snowflake_props,
                              data_retention_days: Number(e.target.value) || 0,
                            },
                          })
                        }
                        className="w-full bg-slate-900 font-mono text-white px-2 py-1 rounded border border-slate-800"
                      />
                    </div>
                  </div>
                )}

                {targetDialect === 'sql_server' && (
                  <div className="space-y-2">
                    <div>
                      <label className="text-[10px] text-slate-400 block mb-0.5">
                        Target FILEGROUP
                      </label>
                      <input
                        disabled={isPhysicalLocked}
                        value={selectedEntity.sql_server_props.filegroup}
                        onChange={(e) =>
                          updateEntity(selectedEntity.id, {
                            sql_server_props: {
                              ...selectedEntity.sql_server_props,
                              filegroup: e.target.value,
                            },
                          })
                        }
                        className="w-full bg-slate-900 font-mono text-white px-2 py-1 rounded border border-slate-800"
                      />
                    </div>

                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        disabled={isPhysicalLocked}
                        checked={selectedEntity.sql_server_props.clustered_columnstore}
                        onChange={(e) =>
                          updateEntity(selectedEntity.id, {
                            sql_server_props: {
                              ...selectedEntity.sql_server_props,
                              clustered_columnstore: e.target.checked,
                            },
                          })
                        }
                        className="rounded accent-emerald-500"
                      />
                      <span className="text-slate-300">
                        CLUSTERED COLUMNSTORE INDEX
                      </span>
                    </label>

                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        disabled={isPhysicalLocked}
                        checked={selectedEntity.sql_server_props.system_versioned_temporal}
                        onChange={(e) =>
                          updateEntity(selectedEntity.id, {
                            sql_server_props: {
                              ...selectedEntity.sql_server_props,
                              system_versioned_temporal: e.target.checked,
                            },
                          })
                        }
                        className="rounded accent-emerald-500"
                      />
                      <span className="text-slate-300">
                        SYSTEM_VERSIONING Temporal Table
                      </span>
                    </label>
                  </div>
                )}

                {targetDialect === 'oracle' && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] text-slate-400 block mb-0.5">
                          TABLESPACE
                        </label>
                        <input
                          disabled={isPhysicalLocked}
                          value={selectedEntity.oracle_props.tablespace}
                          onChange={(e) =>
                            updateEntity(selectedEntity.id, {
                              oracle_props: {
                                ...selectedEntity.oracle_props,
                                tablespace: e.target.value.toUpperCase(),
                              },
                            })
                          }
                          className="w-full bg-slate-900 font-mono text-white px-2 py-1 rounded border border-slate-800"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-400 block mb-0.5">
                          INDEX TABLESPACE
                        </label>
                        <input
                          disabled={isPhysicalLocked}
                          value={selectedEntity.oracle_props.index_tablespace}
                          onChange={(e) =>
                            updateEntity(selectedEntity.id, {
                              oracle_props: {
                                ...selectedEntity.oracle_props,
                                index_tablespace: e.target.value.toUpperCase(),
                              },
                            })
                          }
                          className="w-full bg-slate-900 font-mono text-white px-2 py-1 rounded border border-slate-800"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="text-[10px] text-slate-400 block mb-0.5">
                        PARTITION BY RANGE Column
                      </label>
                      <input
                        disabled={isPhysicalLocked}
                        value={selectedEntity.oracle_props.partition_by_range_col || ''}
                        onChange={(e) =>
                          updateEntity(selectedEntity.id, {
                            oracle_props: {
                              ...selectedEntity.oracle_props,
                              partition_by_range_col: e.target.value.trim()
                                ? e.target.value.toUpperCase()
                                : null,
                            },
                          })
                        }
                        placeholder="e.g. CLM_INCURRED_DT"
                        className="w-full bg-slate-900 font-mono text-white px-2 py-1 rounded border border-slate-800"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* dbt Configuration */}
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2.5">
              <div className="text-[11px] font-bold text-emerald-400 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5" />
                dbt Model Configuration
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-slate-400 block mb-1">
                    Materialization
                  </label>
                  <select
                    disabled={isPhysicalLocked}
                    value={selectedEntity.dbt_materialization}
                    onChange={(e) =>
                      updateEntity(selectedEntity.id, {
                        dbt_materialization: e.target.value as DbtMaterialization,
                      })
                    }
                    className="w-full bg-slate-900 text-white px-2 py-1 rounded border border-slate-800"
                  >
                    <option value="table">table</option>
                    <option value="incremental">incremental</option>
                    <option value="view">view</option>
                    <option value="ephemeral">ephemeral</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-slate-400 block mb-1">
                    DAG Layer
                  </label>
                  <select
                    disabled={isPhysicalLocked}
                    value={selectedEntity.dbt_layer}
                    onChange={(e) =>
                      updateEntity(selectedEntity.id, {
                        dbt_layer: e.target.value as DbtLayer,
                      })
                    }
                    className="w-full bg-slate-900 text-white px-2 py-1 rounded border border-slate-800"
                  >
                    <option value="source">source</option>
                    <option value="staging">staging</option>
                    <option value="intermediate">intermediate</option>
                    <option value="mart">mart</option>
                  </select>
                </div>
              </div>
            </div>

            {/* TABLE VOLUMETRICS & PROFILING SUMMARY */}
            <div className="p-3 rounded-xl bg-slate-950 border border-emerald-500/30 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-emerald-400 flex items-center gap-1.5">
                  <BarChart3 className="w-3.5 h-3.5" />
                  Volumetrics &amp; Auto-DQ Rules
                </span>
                <button
                  type="button"
                  disabled={isPhysicalLocked}
                  onClick={() => applyRecommendedDq(selectedEntity.id)}
                  className="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-semibold"
                >
                  + Apply Recommended DQ
                </button>
              </div>

              <div className="grid grid-cols-3 gap-1.5">
                <div>
                  <label className="text-[9.5px] text-slate-400 block mb-0.5">
                    Est. Rows
                  </label>
                  <input
                    type="number"
                    disabled={isPhysicalLocked}
                    value={volumetrics.estimated_row_count}
                    onChange={(e) => {
                      const rows = Number(e.target.value) || 0;
                      const sizeGb = Number(
                        ((rows * volumetrics.avg_row_bytes) / 1024 ** 3).toFixed(3)
                      );
                      updateEntity(selectedEntity.id, {
                        volumetrics: {
                          ...volumetrics,
                          estimated_row_count: rows,
                          estimated_size_gb: sizeGb,
                        },
                      });
                    }}
                    className="w-full bg-slate-900 font-mono text-[11px] text-white px-1.5 py-1 rounded border border-slate-800"
                  />
                </div>
                <div>
                  <label className="text-[9.5px] text-slate-400 block mb-0.5">
                    Growth %/mo
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    disabled={isPhysicalLocked}
                    value={volumetrics.monthly_growth_pct}
                    onChange={(e) =>
                      updateEntity(selectedEntity.id, {
                        volumetrics: {
                          ...volumetrics,
                          monthly_growth_pct: Number(e.target.value) || 0,
                        },
                      })
                    }
                    className="w-full bg-slate-900 font-mono text-[11px] text-white px-1.5 py-1 rounded border border-slate-800"
                  />
                </div>
                <div>
                  <label className="text-[9.5px] text-slate-400 block mb-0.5">
                    Est. Footprint
                  </label>
                  <div className="bg-slate-900 font-mono text-[11px] text-emerald-300 px-2 py-1 rounded border border-slate-800">
                    {volumetrics.estimated_size_gb} GB
                  </div>
                </div>
              </div>
            </div>
          </InspectorSection>
        </div>
      )}

      {/* Case 4: Nothing Selected */}
      {!selectedEntity && !selectedRelationship && (
        <div className="p-5 space-y-4 text-xs">
          <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2.5">
            <div className="font-bold text-slate-200 flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-violet-400" />
              Project-Wide AI Governance &amp; Profiling
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Run AI Metadata Generation, Statistical Data Profiling, or DQ Rule Synthesis across all tables and views in the workspace.
            </p>
            <button
              type="button"
              disabled={isViewer}
              onClick={() => autoGenerateMetadata(null)}
              className="w-full py-2 px-3 rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-semibold text-xs flex items-center justify-center gap-1.5 shadow"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Auto-Generate All Definitions &amp; Policies</span>
            </button>
            <button
              type="button"
              onClick={() => runDataProfiler(null)}
              className="w-full py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs flex items-center justify-center gap-1.5 shadow"
            >
              <BarChart3 className="w-3.5 h-3.5" />
              <span>Profile All Tables &amp; Volumetrics</span>
            </button>
            <button
              type="button"
              disabled={isPhysicalLocked}
              onClick={() => applyRecommendedDq(null)}
              className="w-full py-1.5 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-slate-700 font-semibold text-xs flex items-center justify-center gap-1.5"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Apply All Recommended DQ Rules</span>
            </button>
          </div>

          <div className="text-center text-slate-500 space-y-1.5 px-2">
            <p className="text-[11px]">
              Click any Table, View, Column, or Relationship on the canvas to inspect its Retention Policy, Data Profile, Lineage Blast Radius, and Open Data Contract SLAs.
            </p>
          </div>
        </div>
      )}
    </aside>
  );
};
