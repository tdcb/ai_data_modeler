import React from 'react';
import { History, MessageSquare, Share2 } from 'lucide-react';
import { ROLE_LABEL, openThreadCounts, useCollabStore } from '../../store/useCollabStore';
import { useModelStore } from '../../store/useModelStore';

const initials = (name: string) =>
  name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

export const PresenceBar: React.FC = () => {
  const status = useCollabStore((s) => s.status);
  const peers = useCollabStore((s) => s.peers);
  const you = useCollabStore((s) => s.you);
  const comments = useCollabStore((s) => s.comments);
  const openPanel = useCollabStore((s) => s.openPanel);
  const entities = useModelStore((s) => s.project.entities);
  const others = peers.filter((p) => p.client_id !== you?.client_id);
  const openCount = Object.values(openThreadCounts(comments)).reduce((a, b) => a + b, 0) +
    new Set(comments.filter((c) => !c.resolved && !c.entity_id).map((c) => c.thread_id)).size;

  return (
    <div className="flex items-center gap-1.5" data-testid="presence-bar">
      <span
        title={status === 'live' ? 'Live collaboration connected' : status === 'connecting' ? 'Connecting…' : 'Offline'}
        className={`w-2 h-2 rounded-full ${status === 'live' ? 'bg-emerald-400' : status === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-slate-600'}`}
      />
      <div className="flex -space-x-1.5">
        {[...(you ? [you] : []), ...others].slice(0, 6).map((p) => {
          const sel = p.selection?.entity_id ? entities[p.selection.entity_id]?.physical_name : null;
          return (
            <span
              key={p.client_id}
              data-testid="presence-avatar"
              title={`${p.name}${p.client_id === you?.client_id ? ' (you)' : ''} · ${ROLE_LABEL[p.role] || p.role} · ${p.view}${sel ? ` · on ${sel}` : ''}`}
              className="w-6 h-6 rounded-full text-[10px] font-bold text-white flex items-center justify-center border-2 border-slate-900"
              style={{ background: p.color }}
            >
              {initials(p.name)}
            </span>
          );
        })}
        {others.length > 5 && (
          <span className="w-6 h-6 rounded-full text-[10px] bg-slate-700 text-white flex items-center justify-center border-2 border-slate-900">
            +{others.length - 5}
          </span>
        )}
      </div>
      <button
        type="button"
        title="Comments"
        onClick={() => openPanel('comments')}
        className="relative p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
      >
        <MessageSquare className="w-3.5 h-3.5" />
        {openCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-0.5 rounded-full bg-amber-500 text-[9px] font-bold text-slate-950 flex items-center justify-center">
            {openCount}
          </span>
        )}
      </button>
      <button
        type="button"
        title="Activity & version history"
        onClick={() => openPanel('activity')}
        className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
      >
        <History className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        title="Share this model"
        onClick={() => openPanel('people')}
        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white border border-sky-500"
      >
        <Share2 className="w-3.5 h-3.5" />
        <span>Share</span>
      </button>
    </div>
  );
};
