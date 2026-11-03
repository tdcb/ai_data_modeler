import React, { useCallback, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  useReactFlow,
  type Node,
  type Edge,
  type OnConnect,
  type OnNodesChange,
  type NodeProps,
} from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';
import { StickyNote, Trash2 } from 'lucide-react';
import { TableNode } from './TableNode';
import { CrowFootEdge } from './CrowFootEdge';
import { useModelStore } from '../../store/useModelStore';
import type { StickyNoteModel } from '../../types/metamodel';

const elk = new ELK();

const StickyNoteNode: React.FC<NodeProps> = ({ data }) => {
  const note = (data as unknown as { note: StickyNoteModel }).note;
  const updateStickyNote = useModelStore((s) => s.updateStickyNote);
  const deleteStickyNote = useModelStore((s) => s.deleteStickyNote);

  return (
    <div
      style={{ backgroundColor: note.color || '#fef08a' }}
      className="w-64 p-3 rounded-lg shadow-xl border border-amber-400/60 text-slate-900 text-xs"
    >
      <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-amber-900/15 font-semibold text-[11px] text-amber-950">
        <span className="flex items-center gap-1">
          <StickyNote className="w-3.5 h-3.5" />
          Canvas Note ({note.subject_area})
        </span>
        <button
          type="button"
          onClick={() => deleteStickyNote(note.id)}
          className="text-amber-900/60 hover:text-rose-700"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
      <textarea
        value={note.text}
        onChange={(e) => updateStickyNote(note.id, { text: e.target.value })}
        rows={4}
        className="w-full bg-transparent resize-none outline-none text-slate-900 text-xs leading-relaxed font-medium"
      />
    </div>
  );
};

const nodeTypes = {
  tableNode: TableNode,
  stickyNote: StickyNoteNode,
};

const edgeTypes = {
  crowFoot: CrowFootEdge,
};

export const ERDCanvas: React.FC = () => {
  const project = useModelStore((s) => s.project);
  const activeSubjectArea = useModelStore((s) => s.activeSubjectArea);
  const selectedEntityId = useModelStore((s) => s.selectedEntityId);
  const selectedColumnId = useModelStore((s) => s.selectedColumnId);
  const selectedRelationshipId = useModelStore((s) => s.selectedRelationshipId);

  const updateEntityPosition = useModelStore((s) => s.updateEntityPosition);
  const applyLayoutPositions = useModelStore((s) => s.applyLayoutPositions);
  const connectEntitiesWithRelationship = useModelStore(
    (s) => s.connectEntitiesWithRelationship
  );
  const selectEntity = useModelStore((s) => s.selectEntity);
  const addColumn = useModelStore((s) => s.addColumn);
  const deleteColumn = useModelStore((s) => s.deleteColumn);
  const deleteEntity = useModelStore((s) => s.deleteEntity);
  const deleteRelationship = useModelStore((s) => s.deleteRelationship);

  // Filter entities by active Subject Area
  const visibleEntities = useMemo(() => {
    return Object.values(project.entities).filter(
      (e) =>
        activeSubjectArea === 'All' ||
        e.subject_area.toLowerCase() === activeSubjectArea.toLowerCase()
    );
  }, [project.entities, activeSubjectArea]);

  const visibleEntityIds = useMemo(
    () => new Set(visibleEntities.map((e) => e.id)),
    [visibleEntities]
  );

  // Build React Flow nodes
  const nodes: Node[] = useMemo(() => {
    const tableNodes: Node[] = visibleEntities.map((ent) => ({
      id: ent.id,
      type: 'tableNode',
      position: ent.position || { x: 100, y: 100 },
      selected: selectedEntityId === ent.id,
      data: { entity: ent },
    }));

    const noteNodes: Node[] = Object.values(project.annotations || {})
      .filter(
        (n) =>
          activeSubjectArea === 'All' ||
          n.subject_area.toLowerCase() === activeSubjectArea.toLowerCase()
      )
      .map((note) => ({
        id: note.id,
        type: 'stickyNote',
        position: note.position || { x: 80, y: 500 },
        data: { note },
      }));

    return [...tableNodes, ...noteNodes];
  }, [visibleEntities, project.annotations, activeSubjectArea, selectedEntityId]);

  // Build React Flow edges
  const edges: Edge[] = useMemo(() => {
    return Object.values(project.relationships)
      .filter(
        (rel) =>
          visibleEntityIds.has(rel.parent_entity_id) &&
          visibleEntityIds.has(rel.child_entity_id)
      )
      .map((rel) => ({
        id: rel.id,
        source: rel.parent_entity_id,
        target: rel.child_entity_id,
        sourceHandle: rel.parent_column_id,
        targetHandle: rel.child_column_id,
        type: 'crowFoot',
        selected: selectedRelationshipId === rel.id,
        data: { relationship: rel },
      }));
  }, [project.relationships, visibleEntityIds, selectedRelationshipId]);

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      changes.forEach((change) => {
        if (change.type === 'position' && change.position) {
          updateEntityPosition(change.id, change.position);
        }
      });
    },
    [updateEntityPosition]
  );

  const onConnect: OnConnect = useCallback(
    (connection) => {
      if (!connection.source || !connection.target) return;
      const srcColId =
        connection.sourceHandle && !connection.sourceHandle.startsWith('ent-')
          ? connection.sourceHandle
          : null;
      const tgtColId =
        connection.targetHandle && !connection.targetHandle.startsWith('ent-')
          ? connection.targetHandle
          : null;
      connectEntitiesWithRelationship(
        connection.source,
        connection.target,
        srcColId,
        tgtColId,
        'non_identifying'
      );
    },
    [connectEntitiesWithRelationship]
  );

  // ELKjs Layered Orthogonal Auto-Layout
  const runElkAutoLayout = useCallback(async () => {
    if (visibleEntities.length === 0) return;
    const graph = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.spacing.nodeNode': '90',
        'elk.layered.spacing.nodeNodeBetweenLayers': '140',
        'elk.edgeRouting': 'ORTHOGONAL',
      },
      children: visibleEntities.map((ent) => ({
        id: ent.id,
        width: 340,
        height: 85 + ent.columns.length * 32,
      })),
      edges: edges.map((e) => ({
        id: e.id,
        sources: [e.source],
        targets: [e.target],
      })),
    };

    try {
      const layouted = await elk.layout(graph);
      const newPositions: Record<string, { x: number; y: number }> = {};
      layouted.children?.forEach((child) => {
        if (child.x !== undefined && child.y !== undefined) {
          newPositions[child.id] = { x: child.x + 60, y: child.y + 60 };
        }
      });
      applyLayoutPositions(newPositions);
    } catch (err) {
      console.error('ELK auto-layout error:', err);
    }
  }, [visibleEntities, edges, applyLayoutPositions]);

  // Center the canvas on an entity picked in the Dictionary, Search or AI Companion
  const { setCenter } = useReactFlow();
  useEffect(() => {
    const handler = (ev: Event) => {
      const id = (ev as CustomEvent<{ entityId: string }>).detail?.entityId;
      const ent = id ? useModelStore.getState().project.entities[id] : undefined;
      if (!ent) return;
      const pos = ent.position || { x: 0, y: 0 };
      setCenter(pos.x + 160, pos.y + 40 + ent.columns.length * 12, { zoom: 1.05, duration: 600 });
    };
    window.addEventListener('metaforge:focus-entity', handler);
    return () => window.removeEventListener('metaforge:focus-entity', handler);
  }, [setCenter]);

  // Listen to custom 'metaforge:auto-layout' event from TopToolbar
  useEffect(() => {
    const handler = () => {
      runElkAutoLayout();
    };
    window.addEventListener('metaforge:auto-layout', handler);
    return () => window.removeEventListener('metaforge:auto-layout', handler);
  }, [runElkAutoLayout]);

  // Global Keyboard Shortcuts: Ctrl+Z, Ctrl+Y, Insert, Delete
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInputFocused =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      // Undo/redo is handled app-wide in App.tsx so it works in every view.
      if (e.metaKey || e.ctrlKey) return;

      if (isInputFocused) return;

      if (e.key === 'Insert' && selectedEntityId) {
        e.preventDefault();
        addColumn(selectedEntityId);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedRelationshipId) {
          e.preventDefault();
          deleteRelationship(selectedRelationshipId);
        } else if (selectedEntityId && selectedColumnId) {
          e.preventDefault();
          deleteColumn(selectedEntityId, selectedColumnId);
        } else if (selectedEntityId) {
          e.preventDefault();
          deleteEntity(selectedEntityId);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    selectedEntityId,
    selectedColumnId,
    selectedRelationshipId,
    addColumn,
    deleteColumn,
    deleteEntity,
    deleteRelationship,
  ]);

  return (
    <div className="relative w-full h-full bg-slate-950">
      {/* Custom SVG Definitions for Crow's Foot & IDEF1X Relationship Markers */}
      <svg className="absolute w-0 h-0 pointer-events-none">
        <defs>
          {/* Parent 1 Marker */}
          <marker
            id="crowsfoot-parent-one"
            viewBox="0 0 16 16"
            refX="4"
            refY="8"
            markerWidth="12"
            markerHeight="12"
            orient="auto"
          >
            <line
              x1="6"
              y1="2"
              x2="6"
              y2="14"
              stroke="#94a3b8"
              strokeWidth="2"
            />
          </marker>

          {/* 1:N Crow's Foot (One or Many) */}
          <marker
            id="crowsfoot-one-many"
            viewBox="0 0 20 20"
            refX="18"
            refY="10"
            markerWidth="14"
            markerHeight="14"
            orient="auto"
          >
            <line x1="2" y1="3" x2="2" y2="17" stroke="#f59e0b" strokeWidth="2" />
            <path
              d="M 6 10 L 18 3 M 6 10 L 18 10 M 6 10 L 18 17"
              stroke="#f59e0b"
              strokeWidth="1.8"
              fill="none"
            />
          </marker>

          {/* 0:N Crow's Foot (Zero or Many) */}
          <marker
            id="crowsfoot-zero-many"
            viewBox="0 0 24 20"
            refX="22"
            refY="10"
            markerWidth="16"
            markerHeight="14"
            orient="auto"
          >
            <circle
              cx="5"
              cy="10"
              r="3.5"
              stroke="#38bdf8"
              strokeWidth="1.8"
              fill="#0f172a"
            />
            <path
              d="M 10 10 L 22 3 M 10 10 L 22 10 M 10 10 L 22 17"
              stroke="#38bdf8"
              strokeWidth="1.8"
              fill="none"
            />
          </marker>

          {/* 1:1 Marker */}
          <marker
            id="crowsfoot-one-one"
            viewBox="0 0 20 20"
            refX="16"
            refY="10"
            markerWidth="14"
            markerHeight="14"
            orient="auto"
          >
            <line x1="6" y1="3" x2="6" y2="17" stroke="#94a3b8" strokeWidth="2" />
            <line x1="12" y1="3" x2="12" y2="17" stroke="#94a3b8" strokeWidth="2" />
          </marker>

          {/* 0:1 Marker */}
          <marker
            id="crowsfoot-zero-one"
            viewBox="0 0 20 20"
            refX="16"
            refY="10"
            markerWidth="14"
            markerHeight="14"
            orient="auto"
          >
            <circle
              cx="6"
              cy="10"
              r="3.5"
              stroke="#94a3b8"
              strokeWidth="1.8"
              fill="#0f172a"
            />
            <line x1="13" y1="3" x2="13" y2="17" stroke="#94a3b8" strokeWidth="2" />
          </marker>
        </defs>
      </svg>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onPaneClick={() => selectEntity(null, null)}
        snapToGrid
        snapGrid={[16, 16]}
        fitView
        minZoom={0.2}
        maxZoom={1.8}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.2}
          color="#334155"
        />
        <Controls position="bottom-left" />
        <MiniMap
          position="bottom-right"
          nodeColor={(node) => {
            const ent = (node.data as { entity?: { header_color?: string } })?.entity;
            return ent?.header_color || '#3b82f6';
          }}
          maskColor="rgba(2, 6, 23, 0.75)"
        />
      </ReactFlow>
    </div>
  );
};
