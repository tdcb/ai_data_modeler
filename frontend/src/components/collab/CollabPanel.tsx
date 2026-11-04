import React, { useMemo, useState } from 'react';
import { Check, Copy, History, Link2, MessageSquare, RotateCcw, Send, Trash2, Users, X } from 'lucide-react';
import {
  ROLE_LABEL,
  type CollabComment,
  type CollabPermission,
  type PeerSelection,
  useCollabStore,
} from '../../store/useCollabStore';
import { useModelStore } from '../../store/useModelStore';

const RANK: Record<string, number> = { NONE: 0, VIEW: 1, COMMENT: 2, EDIT: 3, ADMIN: 4 };
const ROLES: CollabPermission[] = ['VIEW', 'COMMENT', 'EDIT', 'ADMIN'];

const when = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`);
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return d.toLocaleDateString();
};

const highlight = (body: string) =>
  body.split(/(@[\w.+-]+(?:@[\w-]+\.[\w.]+)?)/g).map((part, i) =>
    part.startsWith('@') ? (
      <span key={i} className="text-sky-300 font-semibold">
        {part}
      </span>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    )
  );

export const CollabPanel: React.FC = () => {
  const s = useCollabStore();
  const project = useModelStore((m) => m.project);
  const selEnt = useModelStore((m) => m.selectedEntityId);
  const selCol = useModelStore((m) => m.selectedColumnId);
  const selRel = useModelStore((m) => m.selectedRelationshipId);
  const focusEntity = useModelStore((m) => m.focusEntity);
  const selectRelationship = useModelStore((m) => m.selectRelationship);
  const currentUser = useModelStore((m) => m.currentUser);
  const [draft, setDraft] = useState('');
  const [onModel, setOnModel] = useState(false);
  const [filter, setFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const [onlyFocus, setOnlyFocus] = useState(true);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<CollabPermission>('EDIT');
  const [linkRole, setLinkRole] = useState<CollabPermission>('VIEW');
  const [lastLink, setLastLink] = useState('');
  const [err, setErr] = useState('');

  const canComment = RANK[s.myPermission] >= RANK.COMMENT;
  const canEdit = RANK[s.myPermission] >= RANK.EDIT;
  const isOwner = s.myPermission === 'ADMIN';

  const target: PeerSelection & { target_type: string } = useMemo(() => {
    const f = s.commentFocus;
    if (onModel) return { target_type: 'model' };
    if (f?.relationship_id) return { target_type: 'relationship', relationship_id: f.relationship_id };
    if (f?.entity_id) return { target_type: f.column_id ? 'column' : 'entity', entity_id: f.entity_id, column_id: f.column_id };
    if (selRel) return { target_type: 'relationship', relationship_id: selRel };
    if (selEnt) return { target_type: selCol ? 'column' : 'entity', entity_id: selEnt, column_id: selCol };
    return { target_type: 'model' };
  }, [s.commentFocus, onModel, selEnt, selCol, selRel]);

  const label = (t: { entity_id?: string | null; column_id?: string | null; relationship_id?: string | null }) => {
    if (t.relationship_id) return `Relationship ${project.relationships[t.relationship_id]?.name || t.relationship_id}`;
    if (t.entity_id) {
      const e = project.entities[t.entity_id];
      if (!e) return 'Deleted table';
      const c = t.column_id ? e.columns.find((x) => x.id === t.column_id) : null;
      return c ? `${e.physical_name}.${c.physical_name}` : e.physical_name;
    }
    return 'Whole model';
  };

  const threads = useMemo(() => {
    const map = new Map<string, CollabComment[]>();
    for (const c of s.comments) map.set(c.thread_id, [...(map.get(c.thread_id) || []), c]);
    let list = [...map.values()];
    if (filter !== 'all') list = list.filter((t) => t[0].resolved === (filter === 'resolved'));
    const f = s.commentFocus;
    if (onlyFocus && f?.entity_id) list = list.filter((t) => t[0].entity_id === f.entity_id);
    if (onlyFocus && f?.relationship_id) list = list.filter((t) => t[0].relationship_id === f.relationship_id);
    return list.sort((a, b) => b[b.length - 1].id - a[a.length - 1].id);
  }, [s.comments, filter, onlyFocus, s.commentFocus]);

  if (!s.panelOpen) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const goTo = (c: CollabComment) => {
    if (c.entity_id) focusEntity(c.entity_id, c.column_id);
    else if (c.relationship_id) selectRelationship(c.relationship_id);
  };

  const tabBtn = (t: typeof s.panelTab, icon: React.ReactNode, text: string) => (
    <button
      type="button"
      onClick={() => s.openPanel(t, s.commentFocus)}
      className={`flex items-center gap-1 px-2.5 py-1 rounded text-[11px] ${s.panelTab === t ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}
    >
      {icon}
      {text}
    </button>
  );

  return (
    <aside className="w-[380px] bg-slate-900 border-l border-slate-800 flex flex-col shrink-0 z-10 min-h-0" data-testid="collab-panel">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800">
        <Users className="w-4 h-4 text-sky-400" />
        <span className="text-sm font-semibold text-white">Collaborate</span>
        <span className="text-[10px] text-slate-500">
          {s.status === 'live' ? `live · v${s.version}` : s.status} · you are {ROLE_LABEL[s.myPermission]}
        </span>
        <button type="button" className="ml-auto text-slate-400 hover:text-white" onClick={s.closePanel} title="Close">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex gap-1 px-2 py-1.5 border-b border-slate-800">
        {tabBtn('comments', <MessageSquare className="w-3 h-3" />, 'Comments')}
        {tabBtn('activity', <History className="w-3 h-3" />, 'Activity')}
        {tabBtn('people', <Users className="w-3 h-3" />, 'People & sharing')}
      </div>
      {err && <div className="mx-3 mt-2 text-[11px] text-rose-300 bg-rose-950/40 border border-rose-800 rounded px-2 py-1">{err}</div>}

      {s.panelTab === 'comments' && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="p-3 border-b border-slate-800 space-y-1.5">
            <div className="flex items-center gap-2 text-[11px] text-slate-400">
              <span>On:</span>
              <span className="font-mono text-slate-200 truncate">{label(target)}</span>
              <label className="ml-auto flex items-center gap-1">
                <input type="checkbox" checked={onModel} onChange={(e) => setOnModel(e.target.checked)} /> whole model
              </label>
            </div>
            <textarea
              data-testid="comment-input"
              disabled={!canComment}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={canComment ? 'Add a comment… use @name to mention someone' : 'Viewers cannot comment'}
              className="w-full h-16 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 resize-none"
            />
            <div className="flex items-center gap-2">
              <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="bg-slate-950 border border-slate-700 rounded text-[11px] text-slate-300 px-1 py-0.5">
                <option value="open">Open</option>
                <option value="resolved">Resolved</option>
                <option value="all">All</option>
              </select>
              {s.commentFocus && (
                <label className="flex items-center gap-1 text-[11px] text-slate-400">
                  <input type="checkbox" checked={onlyFocus} onChange={(e) => setOnlyFocus(e.target.checked)} /> only {label(s.commentFocus)}
                </label>
              )}
              <button
                type="button"
                data-testid="comment-post"
                disabled={!canComment || !draft.trim()}
                onClick={() => run(async () => { await s.addComment(draft, target); setDraft(''); })}
                className="ml-auto flex items-center gap-1 px-2 py-1 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white text-[11px] font-semibold"
              >
                <Send className="w-3 h-3" /> Comment
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {threads.length === 0 && <div className="text-center text-xs text-slate-500 py-6">No {filter !== 'all' ? filter : ''} comments.</div>}
            {threads.map((t) => (
              <div key={t[0].thread_id} data-testid="comment-thread" className={`rounded-lg border ${t[0].resolved ? 'border-slate-800 opacity-70' : 'border-slate-700'} bg-slate-950/60`}>
                <div className="flex items-center gap-2 px-2 py-1 border-b border-slate-800">
                  <button type="button" onClick={() => goTo(t[0])} className="font-mono text-[11px] text-sky-300 hover:underline truncate">
                    {label(t[0])}
                  </button>
                  {canComment && (
                    <button
                      type="button"
                      data-testid="comment-resolve"
                      onClick={() => run(() => s.setResolved(t[0].id, !t[0].resolved))}
                      className="ml-auto flex items-center gap-1 text-[10px] text-slate-400 hover:text-emerald-300"
                    >
                      {t[0].resolved ? <RotateCcw className="w-3 h-3" /> : <Check className="w-3 h-3" />}
                      {t[0].resolved ? 'Reopen' : 'Resolve'}
                    </button>
                  )}
                </div>
                {t.map((c) => (
                  <div key={c.id} className={`px-2 py-1.5 ${c.parent_id ? 'pl-5' : ''}`}>
                    <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                      <span className="text-slate-200 font-semibold">{c.author_name}</span>
                      <span>{when(c.created_at)}</span>
                      {(c.author_email === currentUser.email || isOwner) && (
                        <button type="button" title="Delete" onClick={() => run(() => s.deleteComment(c.id))} className="ml-auto hover:text-rose-300">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                    <div className="text-xs text-slate-300 whitespace-pre-wrap">{highlight(c.body)}</div>
                  </div>
                ))}
                {canComment && (
                  <div className="flex gap-1 px-2 pb-2">
                    <input
                      data-testid="comment-reply"
                      value={replies[t[0].thread_id] || ''}
                      onChange={(e) => setReplies({ ...replies, [t[0].thread_id]: e.target.value })}
                      onKeyDown={(e) => {
                        const v = replies[t[0].thread_id] || '';
                        if (e.key === 'Enter' && v.trim())
                          run(async () => { await s.addComment(v, {}, t[0].thread_id); setReplies({ ...replies, [t[0].thread_id]: '' }); });
                      }}
                      placeholder="Reply…"
                      className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-0.5 text-[11px] text-slate-200"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {s.panelTab === 'activity' && (
        <div className="flex-1 overflow-y-auto p-2 space-y-1" data-testid="activity-feed">
          {s.activity.length === 0 && <div className="text-center text-xs text-slate-500 py-6">No activity yet.</div>}
          {s.activity.map((a) => (
            <div key={a.id} className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-slate-800/50" data-testid="activity-item">
              <span className="mt-0.5 text-[9px] uppercase tracking-wide px-1 rounded bg-slate-800 text-slate-400 shrink-0">{a.kind}</span>
              <div className="min-w-0 flex-1">
                <div className="text-xs text-slate-300">
                  <span className="font-semibold text-white">{a.actor_name}</span> {a.summary}
                </div>
                <div className="text-[10px] text-slate-500">
                  {when(a.created_at)}
                  {a.version ? ` · v${a.version}` : ''}
                </div>
              </div>
              {a.restorable && canEdit && (
                <button
                  type="button"
                  data-testid="activity-restore"
                  title="Restore the model to this version"
                  onClick={() => {
                    if (window.confirm(`Restore the model to version ${a.version}? Everyone in the model will see the change.`))
                      void run(() => s.restore(a.id));
                  }}
                  className="shrink-0 flex items-center gap-1 text-[10px] text-slate-400 hover:text-amber-300"
                >
                  <RotateCcw className="w-3 h-3" /> Restore
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {s.panelTab === 'people' && (
        <div className="flex-1 overflow-y-auto p-3 space-y-4 text-xs" data-testid="people-tab">
          {isOwner ? (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold text-slate-300">Invite by email</div>
              <div className="flex gap-1">
                <input
                  data-testid="invite-email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="name@company.com"
                  className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
                />
                <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as CollabPermission)} className="bg-slate-950 border border-slate-700 rounded px-1 text-slate-300">
                  {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
                <button
                  type="button"
                  data-testid="invite-send"
                  disabled={!inviteEmail.includes('@')}
                  onClick={() => run(async () => {
                    const r = await s.invite(inviteEmail, inviteRole);
                    setLastLink(r.link);
                    setInviteEmail('');
                    useModelStore.setState({ statusBanner: { type: 'success', message: r.accepted ? 'Access granted.' : 'Invite created — share the link below.' } });
                  })}
                  className="px-2 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-semibold"
                >
                  Invite
                </button>
              </div>
              <div className="text-[11px] font-semibold text-slate-300 pt-1">Share link</div>
              <div className="flex gap-1 items-center">
                <span className="text-slate-400">Anyone with the link can join as</span>
                <select value={linkRole} onChange={(e) => setLinkRole(e.target.value as CollabPermission)} className="bg-slate-950 border border-slate-700 rounded px-1 text-slate-300">
                  {ROLES.filter((r) => r !== 'ADMIN').map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
                <button
                  type="button"
                  data-testid="invite-link"
                  onClick={() => run(async () => setLastLink((await s.invite(null, linkRole)).link))}
                  className="ml-auto flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
                >
                  <Link2 className="w-3 h-3" /> Create link
                </button>
              </div>
              {lastLink && (
                <div className="flex gap-1">
                  <input readOnly value={lastLink} data-testid="invite-link-value" className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1 font-mono text-[10px] text-slate-300" />
                  <button type="button" title="Copy" onClick={() => void navigator.clipboard?.writeText(lastLink)} className="px-2 rounded bg-slate-800 border border-slate-700 text-slate-300">
                    <Copy className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="text-[11px] text-slate-400 bg-slate-950/60 border border-slate-800 rounded p-2">
              Only an Owner can invite people or change roles. You are a {ROLE_LABEL[s.myPermission]}.
            </div>
          )}
          <div>
            <div className="text-[11px] font-semibold text-slate-300 mb-1">People with access</div>
            {s.members.filter((m) => m.permission !== 'NONE').map((m) => {
              const peer = s.peers.find((p) => p.email === m.email);
              return (
                <div key={m.email} className="flex items-center gap-2 py-1 border-b border-slate-800/70" data-testid="member-row">
                  <span className="w-2 h-2 rounded-full" style={{ background: peer ? peer.color : '#334155' }} title={peer ? 'Online' : 'Offline'} />
                  <div className="min-w-0 flex-1">
                    <div className="text-slate-200 truncate">{m.name}</div>
                    <div className="text-[10px] text-slate-500 truncate">{m.email} · {m.app_role}</div>
                  </div>
                  {isOwner && m.app_role !== 'Admin' ? (
                    <select
                      value={m.permission}
                      onChange={(e) => run(() => s.setMemberRole(m.email, e.target.value as CollabPermission))}
                      className="bg-slate-950 border border-slate-700 rounded px-1 text-[11px] text-slate-300"
                    >
                      {[...ROLES, 'NONE' as CollabPermission].map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                  ) : (
                    <span className="text-[11px] text-slate-400">{ROLE_LABEL[m.permission]}</span>
                  )}
                </div>
              );
            })}
          </div>
          {isOwner && s.invites.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold text-slate-300 mb-1">Invites & links</div>
              {s.invites.map((i) => (
                <div key={i.token} className="flex items-center gap-2 py-1 text-[11px] text-slate-400">
                  <span className="flex-1 truncate">{i.email || 'Share link'} · {ROLE_LABEL[i.role]}{i.accepted_by_email ? ` · used by ${i.accepted_by_email}` : ''}</span>
                  <button type="button" onClick={() => run(() => s.revokeInvite(i.token))} className="hover:text-rose-300">Revoke</button>
                </div>
              ))}
            </div>
          )}
          <div className="text-[10px] text-slate-500 leading-relaxed">
            Live sessions share model metadata only (tables, columns, keys, definitions) — never row data. Models checked out in the governed
            Repository workflow stay locked to their owner until check-in.
          </div>
        </div>
      )}
    </aside>
  );
};
