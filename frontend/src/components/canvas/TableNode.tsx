import React, { useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  Key,
  Link2,
  ShieldAlert,
  Plus,
  Trash2,
  Database,
  Layers,
  Sparkles,
  GripVertical,
  GitBranch,
  Eye,
} from 'lucide-react';
import type {
  ColumnModel,
  EntityModel,
  RelationshipType,
} from '../../types/metamodel';
import { useModelStore } from '../../store/useModelStore';
import { openThreadCounts, useCollabStore } from '../../store/useCollabStore';
import { MessageSquare } from 'lucide-react';

export interface TableNodeData extends Record<string, unknown> {
  entity: EntityModel;
}

interface DragColumnPayload {
  entityId: string;
  columnId: string;
  colIndex: number;
}

export const TableNode: React.FC<NodeProps> = ({ data, selected }) => {
  const { entity } = data as unknown as TableNodeData;
  const project = useModelStore((s) => s.project);
  const viewMode = useModelStore((s) => s.viewMode);
  const targetDialect = useModelStore((s) => s.targetDialect);
  const domains = useModelStore((s) => s.project.domains);
  const selectedEntityId = useModelStore((s) => s.selectedEntityId);
  const selectedColumnId = useModelStore((s) => s.selectedColumnId);
  const selectEntity = useModelStore((s) => s.selectEntity);
  const addColumn = useModelStore((s) => s.addColumn);
  const updateColumn = useModelStore((s) => s.updateColumn);
  const deleteColumn = useModelStore((s) => s.deleteColumn);
  const updateEntity = useModelStore((s) => s.updateEntity);
  const reorderColumn = useModelStore((s) => s.reorderColumn);
  const connectEntitiesWithRelationship = useModelStore(
    (s) => s.connectEntitiesWithRelationship
  );

  const [editingColId, setEditingColId] = useState<string | null>(null);
  const [editingColVal, setEditingColVal] = useState<string>('');
  const [editingHeader, setEditingHeader] = useState<boolean>(false);
  const [headerVal, setHeaderVal] = useState<string>('');
  const [dragOverColIndex, setDragOverColIndex] = useState<number | null>(null);
  const [isTableDropTarget, setIsTableDropTarget] = useState<boolean>(false);

  // Quick-Link relationship popover state
  const [showLinkPopover, setShowLinkPopover] = useState<boolean>(false);
  const [linkTargetEntityId, setLinkTargetEntityId] = useState<string>('');
  const [linkRelType, setLinkRelType] =
    useState<RelationshipType>('non_identifying');

  const isEntitySelected = selected || selectedEntityId === entity.id;
  const allPeers = useCollabStore((s) => s.peers);
  const youId = useCollabStore((s) => s.you?.client_id);
  const peersHere = React.useMemo(
    () => allPeers.filter((p) => p.client_id !== youId && p.selection?.entity_id === entity.id),
    [allPeers, youId, entity.id]
  );
  const openThreads = useCollabStore((s) => openThreadCounts(s.comments)[entity.id] || 0);
  const openCollab = useCollabStore((s) => s.openPanel);
  const isView =
    entity.entity_type === 'view' || entity.entity_type === 'materialized_view';

  const otherEntities = Object.values(project.entities).filter(
    (e) => e.id !== entity.id
  );

  const getDisplayedDataType = (col: ColumnModel): string => {
    if (viewMode === 'logical') {
      if (col.domain_id && domains[col.domain_id]) {
        return domains[col.domain_id].name;
      }
      return col.data_type_snowflake.split('(')[0];
    }
    if (targetDialect === 'snowflake') return col.data_type_snowflake;
    if (targetDialect === 'sql_server') return col.data_type_sql_server;
    return col.data_type_oracle;
  };

  const getPhysicalStorageBadge = (): string => {
    if (isView) {
      return entity.entity_type === 'materialized_view'
        ? 'SQL: MAT VIEW'
        : 'SQL: VIEW';
    }
    if (targetDialect === 'snowflake') {
      if (entity.snowflake_props.transient) return 'SF: TRANSIENT';
      if (entity.snowflake_props.cluster_by.length > 0)
        return `SF: CLUSTER(${entity.snowflake_props.cluster_by[0]})`;
      return `SF: RET=${entity.snowflake_props.data_retention_days}d`;
    }
    if (targetDialect === 'sql_server') {
      if (entity.sql_server_props.clustered_columnstore) return 'TSQL: COLUMNSTORE';
      if (entity.sql_server_props.system_versioned_temporal) return 'TSQL: TEMPORAL';
      return `FG: ${entity.sql_server_props.filegroup}`;
    }
    if (entity.oracle_props.partition_by_range_col) {
      return `ORA: PART(${entity.oracle_props.partition_by_range_col})`;
    }
    return `TBS: ${entity.oracle_props.tablespace}`;
  };

  const commitColumnRename = (col: ColumnModel) => {
    if (editingColVal.trim()) {
      if (viewMode === 'logical') {
        updateColumn(entity.id, col.id, { logical_name: editingColVal.trim() });
      } else {
        updateColumn(entity.id, col.id, {
          physical_name: editingColVal.trim().toUpperCase().replace(/\s+/g, '_'),
        });
      }
    }
    setEditingColId(null);
  };

  const commitHeaderRename = () => {
    if (headerVal.trim()) {
      if (viewMode === 'logical' || viewMode === 'conceptual') {
        updateEntity(entity.id, { logical_name: headerVal.trim() });
      } else {
        updateEntity(entity.id, {
          physical_name: headerVal.trim().toUpperCase().replace(/\s+/g, '_'),
        });
      }
    }
    setEditingHeader(false);
  };

  const handleColumnDragStart = (
    e: React.DragEvent<HTMLDivElement>,
    col: ColumnModel,
    index: number
  ) => {
    e.stopPropagation();
    const payload: DragColumnPayload = {
      entityId: entity.id,
      columnId: col.id,
      colIndex: index,
    };
    e.dataTransfer.setData(
      'application/metaforge-column',
      JSON.stringify(payload)
    );
    e.dataTransfer.effectAllowed = 'copyMove';
  };

  const handleColumnDrop = (
    e: React.DragEvent<HTMLDivElement>,
    targetCol: ColumnModel,
    targetIndex: number
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverColIndex(null);
    setIsTableDropTarget(false);

    const raw = e.dataTransfer.getData('application/metaforge-column');
    if (!raw) return;
    try {
      const payload = JSON.parse(raw) as DragColumnPayload;
      if (payload.entityId === entity.id) {
        // Same table -> Reorder column position
        if (payload.colIndex !== targetIndex) {
          reorderColumn(entity.id, payload.colIndex, targetIndex);
        }
      } else {
        // Different table -> Create Crow's Foot relationship (or Upstream Lineage if target is a View)
        connectEntitiesWithRelationship(
          payload.entityId,
          entity.id,
          payload.columnId,
          targetCol.id
        );
      }
    } catch {
      // ignore malformed drag data
    }
  };

  const handleTableDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverColIndex(null);
    setIsTableDropTarget(false);

    const raw = e.dataTransfer.getData('application/metaforge-column');
    if (!raw) return;
    try {
      const payload = JSON.parse(raw) as DragColumnPayload;
      if (payload.entityId !== entity.id) {
        connectEntitiesWithRelationship(
          payload.entityId,
          entity.id,
          payload.columnId,
          null
        );
      }
    } catch {
      // ignore
    }
  };

  const primaryTitle =
    viewMode === 'physical'
      ? `${entity.database_schema}.${entity.physical_name}`
      : entity.logical_name;

  const secondarySubtitle =
    viewMode === 'physical' ? entity.logical_name : entity.physical_name;

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        selectEntity(entity.id, null);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/metaforge-column')) {
          e.preventDefault();
          setIsTableDropTarget(true);
        }
      }}
      onDragLeave={() => setIsTableDropTarget(false)}
      onDrop={handleTableDrop}
      data-peer-count={peersHere.length}
      style={peersHere.length ? { boxShadow: peersHere.map((p, i) => `0 0 0 ${2 + i * 3}px ${p.color}`).join(', ') } : undefined}
      className={`relative min-w-[320px] max-w-[380px] rounded-xl bg-slate-900/95 backdrop-blur border transition-all select-none shadow-2xl ${
        isTableDropTarget
          ? 'border-emerald-400 ring-2 ring-emerald-500/50'
          : isEntitySelected
          ? 'border-blue-400 ring-2 ring-blue-500/40'
          : 'border-slate-700/80 hover:border-slate-500'
      }`}
    >
      {(peersHere.length > 0 || openThreads > 0) && (
        <div className="absolute -top-5 left-1 right-1 flex items-center gap-1 pointer-events-none">
          {peersHere.map((p) => (
            <span key={p.client_id} data-testid="peer-tag" className="px-1.5 py-0.5 rounded-t text-[9px] font-semibold text-white" style={{ background: p.color }}>
              {p.name}
            </span>
          ))}
          {openThreads > 0 && (
            <button
              type="button"
              data-testid="comment-badge"
              title={`${openThreads} open comment thread(s)`}
              onClick={(e) => {
                e.stopPropagation();
                openCollab('comments', { entity_id: entity.id });
              }}
              className="ml-auto pointer-events-auto flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-500 text-slate-950 text-[9px] font-bold"
            >
              <MessageSquare className="w-2.5 h-2.5" /> {openThreads}
            </button>
          )}
        </div>
      )}
      {/* Entity-level Left Target & Right Source Handles for quick table-to-table wiring */}
      <Handle
        type="target"
        position={Position.Left}
        id={`ent-target-${entity.id}`}
        title="Drop relationship here (Child / Downstream target)"
        className="!w-3 !h-3 !bg-sky-400 !border-2 !border-slate-950 hover:!scale-125 transition-transform"
      />
      <Handle
        type="source"
        position={Position.Right}
        id={`ent-source-${entity.id}`}
        title="Drag from here to another table to create Crow's Foot relationship"
        className="!w-3 !h-3 !bg-emerald-400 !border-2 !border-slate-950 hover:!scale-125 transition-transform"
      />

      {/* Color-Coded Entity Header (Drag here to move table on canvas) */}
      <div
        style={{ backgroundColor: entity.header_color || '#2563eb' }}
        className="px-3.5 py-2.5 rounded-t-xl flex items-center justify-between gap-2 text-white cursor-grab active:cursor-grabbing"
      >
        <div className="min-w-0 flex-1">
          {editingHeader ? (
            <input
              autoFocus
              value={headerVal}
              onChange={(e) => setHeaderVal(e.target.value)}
              onBlur={commitHeaderRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitHeaderRename();
                if (e.key === 'Escape') setEditingHeader(false);
              }}
              className="nodrag w-full bg-slate-950/60 text-white text-xs font-bold px-1.5 py-0.5 rounded border border-white/40 outline-none"
            />
          ) : (
            <div
              onDoubleClick={(e) => {
                e.stopPropagation();
                setHeaderVal(
                  viewMode === 'physical' ? entity.physical_name : entity.logical_name
                );
                setEditingHeader(true);
              }}
              title="Double-click to inline edit entity name"
              className="font-bold text-sm tracking-tight truncate flex items-center gap-1.5"
            >
              {isView && <Eye className="w-3.5 h-3.5 text-cyan-200 shrink-0" />}
              <span className="truncate">{primaryTitle}</span>
            </div>
          )}
          <div className="text-[10px] text-white/80 font-mono truncate flex items-center gap-1.5">
            <span>{secondarySubtitle}</span>
            <span>•</span>
            <span className="uppercase">{entity.subject_area}</span>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {isView ? (
            <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-cyan-950/80 text-cyan-200 border border-cyan-400/40">
              {entity.entity_type === 'materialized_view' ? 'MAT VIEW' : 'VIEW'}
            </span>
          ) : (
            entity.modeling_stereotype && (
              <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-black/35 text-amber-200 border border-white/15">
                {entity.modeling_stereotype.replace('FCT_TRANSACTION', 'FACT').replace('DIM_', '')}
              </span>
            )
          )}
          <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase rounded bg-black/30 text-white/95 border border-white/15">
            {entity.dbt_layer}
          </span>
        </div>
      </div>

      {/* Enterprise Governance Strip: Retention Policy, Volumetrics & Steward Verification */}
      <div className="px-3 py-1 bg-slate-950/90 border-b border-slate-800/80 flex items-center justify-between gap-2 text-[9.5px] font-mono text-slate-400">
        <div className="flex items-center gap-1.5 truncate">
          {entity.retention_policy?.legal_hold ? (
            <span className="px-1.5 py-0.2 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40 font-bold">
              LEGAL HOLD
            </span>
          ) : entity.retention_policy &&
            entity.retention_policy.regulatory_framework !== 'NONE' ? (
            <span
              title={`Retention Policy: ${entity.retention_policy.regulatory_framework} | Hot: ${entity.retention_policy.active_retention_days}d | Archive: ${entity.retention_policy.archive_retention_days}d (${entity.retention_policy.disposition_action})`}
              className="px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
            >
              {entity.retention_policy.regulatory_framework}:{' '}
              {entity.retention_policy.active_retention_days}d
            </span>
          ) : (
            <span className="text-slate-500">
              Ret: {entity.retention_policy?.active_retention_days || 365}d
            </span>
          )}

          {entity.volumetrics && (
            <span
              title={`Estimated Rows: ${entity.volumetrics.estimated_row_count.toLocaleString()} | Growth: ${entity.volumetrics.monthly_growth_pct}%/mo | Size: ${entity.volumetrics.estimated_size_gb} GB`}
              className="text-emerald-400/90"
            >
              ~
              {entity.volumetrics.estimated_row_count >= 1_000_000
                ? `${(entity.volumetrics.estimated_row_count / 1_000_000).toFixed(1)}M`
                : `${(entity.volumetrics.estimated_row_count / 1_000).toFixed(0)}K`}{' '}
              rows
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {entity.metadata_status === 'STEWARD_VERIFIED' ? (
            <span
              title="Metadata & Definitions Verified by Data Steward"
              className="px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-sans font-semibold"
            >
              ✓ Verified
            </span>
          ) : entity.metadata_status === 'AUTO_GENERATED' ? (
            <span
              title="AI Auto-Generated Definitions (Pending Steward Verification)"
              className="px-1.5 py-0.2 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30 font-sans"
            >
              ✨ Auto-Meta
            </span>
          ) : null}
        </div>
      </div>

      {/* Conceptual View Mode: Show only business description & metadata */}
      {viewMode === 'conceptual' ? (
        <div className="p-3.5 space-y-2.5 text-xs text-slate-300">
          {entity.grain_statement && (
            <div className="text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 px-2 py-1 rounded">
              <span className="font-bold">Grain:</span> {entity.grain_statement}
            </div>
          )}
          <p className="leading-relaxed text-slate-300">
            {entity.description || 'No business description documented yet.'}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-slate-800 text-[10px] text-slate-400">
            <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-medium">
              {entity.columns.length} Attributes
            </span>
            <span className="px-2 py-0.5 rounded bg-slate-800 text-blue-300 font-mono">
              dbt: {entity.dbt_materialization}
            </span>
            <span className="px-2 py-0.5 rounded bg-slate-800 text-emerald-300 font-mono">
              {getPhysicalStorageBadge()}
            </span>
          </div>
        </div>
      ) : (
        <>
          {/* Columns List (Supports Drag-and-Drop to Reorder OR Drop on another Table to Link) */}
          <div className="divide-y divide-slate-800/70 max-h-[380px] overflow-y-auto">
            {entity.columns.map((col, idx) => {
              const isColSelected =
                isEntitySelected && selectedColumnId === col.id;
              const colLabel =
                viewMode === 'logical' ? col.logical_name : col.physical_name;
              const dtypeLabel = getDisplayedDataType(col);
              const isDragOver = dragOverColIndex === idx;

              return (
                <div
                  key={col.id}
                  draggable={editingColId !== col.id}
                  onDragStart={(e) => handleColumnDragStart(e, col, idx)}
                  onDragOver={(e) => {
                    if (
                      e.dataTransfer.types.includes('application/metaforge-column')
                    ) {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverColIndex(idx);
                    }
                  }}
                  onDragLeave={() => {
                    if (dragOverColIndex === idx) setDragOverColIndex(null);
                  }}
                  onDrop={(e) => handleColumnDrop(e, col, idx)}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectEntity(entity.id, col.id);
                  }}
                  title="Drag to reorder within table, or drag & drop onto another table to create a Crow's Foot relationship"
                  className={`nodrag group relative px-2.5 py-1.5 flex items-center justify-between gap-2 text-xs transition-colors cursor-grab active:cursor-grabbing ${
                    isDragOver
                      ? 'bg-emerald-500/25 border-t-2 border-emerald-400 text-white'
                      : isColSelected
                      ? 'bg-blue-600/25 text-white'
                      : 'hover:bg-slate-800/70 text-slate-200'
                  }`}
                >
                  {/* Column Target Handle (Left) */}
                  <Handle
                    type="target"
                    position={Position.Left}
                    id={col.id}
                    className="!w-2.5 !h-2.5 !bg-sky-400 !border-slate-950 opacity-85 group-hover:opacity-100 hover:!scale-125 transition-transform"
                  />

                  {/* Left: Drag Grip + Key Icons + Column Name */}
                  <div className="flex items-center gap-1 min-w-0 flex-1">
                    <GripVertical className="w-3 h-3 text-slate-600 group-hover:text-slate-400 shrink-0" />
                    <span className="w-6 flex items-center gap-0.5 shrink-0">
                      {col.is_pk && (
                        <span title="Primary Key">
                          <Key className="w-3.5 h-3.5 text-amber-400 fill-amber-400/20" />
                        </span>
                      )}
                      {col.is_fk && (
                        <span title="Foreign Key">
                          <Link2 className="w-3.5 h-3.5 text-sky-400" />
                        </span>
                      )}
                      {!col.is_pk && !col.is_fk && (
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-600 ml-1" />
                      )}
                    </span>

                    {editingColId === col.id ? (
                      <input
                        autoFocus
                        value={editingColVal}
                        onChange={(e) => setEditingColVal(e.target.value)}
                        onBlur={() => commitColumnRename(col)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitColumnRename(col);
                          if (e.key === 'Escape') setEditingColId(null);
                        }}
                        className="w-full bg-slate-950 text-white text-xs px-1.5 py-0.5 rounded border border-blue-400 outline-none font-mono"
                      />
                    ) : (
                      <span
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setEditingColId(col.id);
                          setEditingColVal(colLabel);
                        }}
                        title={
                          col.source_expression
                            ? `Expression: ${col.source_expression}`
                            : 'Double-click to rename, or drag column to reorder / link table'
                        }
                        className={`truncate ${
                          col.is_pk
                            ? 'font-semibold text-amber-100'
                            : col.is_fk
                            ? 'text-sky-200'
                            : 'text-slate-200'
                        } ${viewMode === 'physical' ? 'font-mono text-[11px]' : ''}`}
                      >
                        {colLabel}
                      </span>
                    )}

                    {/* View SQL Expression Badge */}
                    {col.source_expression && (
                      <span
                        title={`SQL Expression: ${col.source_expression}`}
                        className="px-1 py-0.2 rounded text-[9px] font-mono bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 shrink-0"
                      >
                        fx
                      </span>
                    )}

                    {/* PII Badge */}
                    {col.pii_classification !== 'NONE' && (
                      <span
                        title={`Governance Classification: ${col.pii_classification}`}
                        className={`px-1 py-0.2 rounded text-[9px] font-bold flex items-center gap-0.5 shrink-0 ${
                          col.pii_classification === 'RESTRICTED_PII'
                            ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                            : col.pii_classification === 'CONFIDENTIAL'
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                            : 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                        }`}
                      >
                        <ShieldAlert className="w-2.5 h-2.5" />
                        {col.pii_classification === 'RESTRICTED_PII'
                          ? 'PII'
                          : col.pii_classification.slice(0, 4)}
                      </span>
                    )}
                  </div>

                  {/* Right: Domain / Dialect Type & Nullability + Delete */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {col.domain_id && viewMode === 'physical' && (
                      <span
                        title={`Bound to Enterprise Domain: ${
                          domains[col.domain_id]?.name || col.domain_id
                        }`}
                        className="text-violet-400"
                      >
                        <Sparkles className="w-3 h-3" />
                      </span>
                    )}
                    <span
                      className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${
                        col.domain_id && viewMode === 'logical'
                          ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                          : 'bg-slate-800/90 text-slate-300'
                      }`}
                    >
                      {dtypeLabel}
                    </span>
                    <span
                      className={`text-[9px] font-mono w-7 text-right ${
                        !col.is_nullable || col.is_pk
                          ? 'text-amber-400/90 font-semibold'
                          : 'text-slate-500'
                      }`}
                    >
                      {!col.is_nullable || col.is_pk ? 'NN' : 'NULL'}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteColumn(entity.id, col.id);
                      }}
                      title="Delete column"
                      className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-rose-400 transition-opacity p-0.5"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>

                  {/* Column Source Handle (Right) */}
                  <Handle
                    type="source"
                    position={Position.Right}
                    id={col.id}
                    className="!w-2.5 !h-2.5 !bg-emerald-400 !border-slate-950 opacity-85 group-hover:opacity-100 hover:!scale-125 transition-transform"
                  />
                </div>
              );
            })}
          </div>

          {/* Quick Relationship / Lineage Linker Popover */}
          {showLinkPopover && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="nodrag p-2.5 bg-slate-950 border-t border-slate-800 space-y-2 text-[11px]"
            >
              <div className="flex items-center justify-between text-sky-400 font-semibold">
                <span>Add Crow&apos;s Foot / Lineage Relation</span>
                <button
                  type="button"
                  onClick={() => setShowLinkPopover(false)}
                  className="text-slate-400 hover:text-white"
                >
                  ×
                </button>
              </div>
              <select
                value={linkTargetEntityId}
                onChange={(e) => setLinkTargetEntityId(e.target.value)}
                className="w-full bg-slate-900 text-white px-2 py-1 rounded border border-slate-700 text-xs"
              >
                <option value="">-- Select Target / Downstream Entity --</option>
                {otherEntities.map((oe) => (
                  <option key={oe.id} value={oe.id}>
                    {oe.physical_name} ({oe.logical_name})
                  </option>
                ))}
              </select>
              <select
                value={linkRelType}
                onChange={(e) =>
                  setLinkRelType(e.target.value as RelationshipType)
                }
                className="w-full bg-slate-900 text-white px-2 py-1 rounded border border-slate-700 text-xs"
              >
                <option value="non_identifying">
                  Parent → Child (Non-Identifying Crow&apos;s Foot FK)
                </option>
                <option value="identifying">
                  Parent → Child (Identifying PK+FK Crow&apos;s Foot)
                </option>
                <option value="upstream_lineage">
                  Upstream → Downstream Data Lineage (ETL / View)
                </option>
              </select>
              <button
                type="button"
                disabled={!linkTargetEntityId}
                onClick={() => {
                  if (!linkTargetEntityId) return;
                  connectEntitiesWithRelationship(
                    entity.id,
                    linkTargetEntityId,
                    null,
                    null,
                    linkRelType
                  );
                  setShowLinkPopover(false);
                }}
                className="w-full py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-semibold"
              >
                Connect Entities
              </button>
            </div>
          )}

          {/* Node Footer: Inline "+ Add Column", "+ Link / FK", & Dialect Storage Badge */}
          <div className="nodrag px-3 py-1.5 bg-slate-950/80 rounded-b-xl border-t border-slate-800/80 flex items-center justify-between gap-2 text-[10px]">
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  addColumn(entity.id);
                }}
                className="flex items-center gap-1 text-blue-400 hover:text-blue-300 font-medium transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Col</span>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!linkTargetEntityId && otherEntities.length > 0) {
                    setLinkTargetEntityId(otherEntities[0].id);
                  }
                  setShowLinkPopover(!showLinkPopover);
                }}
                title="Add a Parent-Child Crow's Foot relationship or Upstream/Downstream Lineage link"
                className="flex items-center gap-1 text-emerald-400 hover:text-emerald-300 font-medium transition-colors"
              >
                <GitBranch className="w-3 h-3" />
                <span>+ Relation</span>
              </button>
            </div>

            <div className="flex items-center gap-2 text-slate-400 font-mono">
              <span className="flex items-center gap-1">
                <Database className="w-3 h-3 text-slate-500" />
                {getPhysicalStorageBadge()}
              </span>
              <span className="flex items-center gap-1 text-emerald-400">
                <Layers className="w-3 h-3" />
                {entity.dbt_materialization}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
