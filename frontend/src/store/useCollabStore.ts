import { create } from 'zustand';
import type { ProjectMetamodel } from '../types/metamodel';
import { api } from '../services/api';
import { useModelStore } from './useModelStore';

export type CollabPermission = 'NONE' | 'VIEW' | 'COMMENT' | 'EDIT' | 'ADMIN';
export const ROLE_LABEL: Record<string, string> = {
  VIEW: 'Viewer',
  COMMENT: 'Commenter',
  EDIT: 'Editor',
  ADMIN: 'Owner',
  NONE: 'No access',
};

export interface PeerSelection {
  entity_id?: string | null;
  column_id?: string | null;
  relationship_id?: string | null;
}
export interface Peer {
  client_id: string;
  email: string;
  name: string;
  role: CollabPermission;
  color: string;
  selection: PeerSelection;
  view: string;
}
export interface CollabComment {
  id: number;
  thread_id: string;
  parent_id: number | null;
  target_type: 'model' | 'entity' | 'column' | 'relationship';
  entity_id: string | null;
  column_id: string | null;
  relationship_id: string | null;
  author_email: string;
  author_name: string;
  body: string;
  mentions: string[];
  resolved: boolean;
  created_at: string | null;
}
export interface ActivityItem {
  id: number;
  version: number;
  actor_email: string;
  actor_name: string;
  kind: string;
  summary: string;
  restorable: boolean;
  created_at: string | null;
}
export interface Member {
  email: string;
  name: string;
  app_role: string;
  permission: CollabPermission;
  online: boolean;
}
export interface Invite {
  token: string;
  email: string | null;
  role: CollabPermission;
  accepted_by_email: string | null;
  created_at: string | null;
}
export type CollabTab = 'comments' | 'activity' | 'people';

interface CollabState {
  modelId: string | null;
  status: 'offline' | 'connecting' | 'live';
  you: Peer | null;
  peers: Peer[];
  version: number;
  myPermission: CollabPermission;
  comments: CollabComment[];
  activity: ActivityItem[];
  members: Member[];
  invites: Invite[];
  panelOpen: boolean;
  panelTab: CollabTab;
  commentFocus: PeerSelection | null;
  openPanel: (tab: CollabTab, focus?: PeerSelection | null) => void;
  closePanel: () => void;
  connect: (modelId: string) => void;
  disconnect: () => void;
  refreshComments: () => Promise<void>;
  refreshActivity: () => Promise<void>;
  refreshMembers: () => Promise<void>;
  addComment: (body: string, target: PeerSelection & { target_type?: string }, threadId?: string) => Promise<void>;
  setResolved: (commentId: number, resolved: boolean) => Promise<void>;
  deleteComment: (commentId: number) => Promise<void>;
  restore: (activityId: number) => Promise<void>;
  invite: (email: string | null, role: CollabPermission) => Promise<{ link: string; accepted: boolean }>;
  revokeInvite: (token: string) => Promise<void>;
  setMemberRole: (email: string, role: CollabPermission) => Promise<void>;
  acceptInvite: (token: string) => Promise<string>;
}

const API_BASE =
  typeof window !== 'undefined' &&
  (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost')
    ? 'http://127.0.0.1:8000/api'
    : '/api';

function wsUrl(path: string): string {
  if (API_BASE.startsWith('http')) return API_BASE.replace(/^http/, 'ws') + path;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}${API_BASE}${path}`;
}

async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = useModelStore.getState().authToken;
  const res = await fetch(`${API_BASE}/collab${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail || detail;
    } catch {
      /* not json */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

const enc = (o: unknown) => JSON.stringify(o ?? null);

/** Ids whose content differs between two records keyed by id. */
function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => enc(a[k]) !== enc(b[k]));
}

/** Apply the remote state of the given entity/relationship ids onto a project snapshot. */
function applyRemote(
  target: ProjectMetamodel,
  remote: ProjectMetamodel,
  entIds: string[],
  relIds: string[],
  takeRest: boolean
): ProjectMetamodel {
  const out: ProjectMetamodel = takeRest
    ? { ...remote, entities: { ...target.entities }, relationships: { ...target.relationships } }
    : { ...target, entities: { ...target.entities }, relationships: { ...target.relationships } };
  for (const id of entIds) {
    if (remote.entities[id]) out.entities[id] = remote.entities[id];
    else delete out.entities[id];
  }
  for (const id of relIds) {
    if (remote.relationships[id]) out.relationships[id] = remote.relationships[id];
    else delete out.relationships[id];
  }
  return out;
}

let socket: WebSocket | null = null;
let wantedModel: string | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let sendTimer: ReturnType<typeof setTimeout> | null = null;
let activityTimer: ReturnType<typeof setTimeout> | null = null;
let applyingRemote = false;
let lastSynced: ProjectMetamodel | null = null;
let unsubscribers: Array<() => void> = [];

const banner = (type: 'info' | 'success' | 'error', message: string) =>
  useModelStore.setState({ statusBanner: { type, message } });

function send(msg: unknown) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function canEdit(): boolean {
  const p = useCollabStore.getState().myPermission;
  return p === 'EDIT' || p === 'ADMIN';
}

function flushEdit() {
  sendTimer = null;
  if (!canEdit()) return;
  const project = useModelStore.getState().project;
  if (lastSynced && enc(project) === enc(lastSynced)) return;
  send({ type: 'set_project', project, base_version: useCollabStore.getState().version });
}

function sendPresence() {
  const s = useModelStore.getState();
  send({
    type: 'presence',
    view: s.workspaceView,
    selection: {
      entity_id: s.selectedEntityId,
      column_id: s.selectedColumnId,
      relationship_id: s.selectedRelationshipId,
    },
  });
}

function scheduleActivity() {
  if (activityTimer) return;
  activityTimer = setTimeout(() => {
    activityTimer = null;
    void useCollabStore.getState().refreshActivity();
  }, 800);
}

function onRemoteProject(
  remote: ProjectMetamodel,
  author: Peer | { name: string },
  summary: string,
  conflicts: string[] = []
) {
  const ms = useModelStore.getState();
  const base = lastSynced ?? ms.project;
  const entRemote = changedKeys(base.entities, remote.entities);
  const relRemote = changedKeys(base.relationships, remote.relationships);
  // Local edits not yet acknowledged reach the server after this change, so they win there too: keep them.
  const mineEnt = new Set(changedKeys(base.entities, ms.project.entities));
  const mineRel = new Set(changedKeys(base.relationships, ms.project.relationships));
  const entIds = entRemote.filter((id) => !mineEnt.has(id));
  const relIds = relRemote.filter((id) => !mineRel.has(id));
  const clash = entRemote.filter((id) => mineEnt.has(id));
  applyingRemote = true;
  useModelStore.setState({
    project: applyRemote(ms.project, remote, entIds, relIds, true),
    pastProjects: ms.pastProjects.map((p) => applyRemote(p, remote, entIds, relIds, false)),
    futureProjects: ms.futureProjects.map((p) => applyRemote(p, remote, entIds, relIds, false)),
  });
  applyingRemote = false;
  lastSynced = remote;
  const nameOf = (id: string) => remote.entities[id]?.physical_name || base.entities[id]?.physical_name || id;
  if (clash.length) {
    banner('error', `Edit conflict: you and ${author.name} changed ${clash.map(nameOf).join(', ')} at the same time — your later edit is kept.`);
  } else if (conflicts.length) {
    banner('error', `Edit conflict: ${author.name} changed ${conflicts.join(', ')} at the same time — their later edit was kept.`);
  } else if (summary) {
    banner('info', `${author.name}: ${summary}`);
  }
}

function handle(msg: Record<string, any>) {
  const set = useCollabStore.setState;
  const st = useCollabStore.getState();
  switch (msg.type) {
    case 'welcome': {
      retry = 0;
      set({ status: 'live', you: msg.you, peers: msg.peers, version: msg.version, myPermission: msg.you.role });
      lastSynced = useModelStore.getState().project;
      if (st.modelId === 'workspace' && msg.version > 0) {
        api
          .getProject(useModelStore.getState().authToken)
          .then((p) => onRemoteProject(p, { name: 'Server' }, ''))
          .catch(() => {});
      }
      sendPresence();
      void st.refreshComments();
      void st.refreshActivity();
      void st.refreshMembers();
      break;
    }
    case 'peer_joined':
      set({ peers: [...st.peers.filter((p) => p.client_id !== msg.peer.client_id), msg.peer] });
      break;
    case 'presence':
      set({ peers: st.peers.map((p) => (p.client_id === msg.peer.client_id ? msg.peer : p)) });
      break;
    case 'peer_left':
      set({ peers: st.peers.filter((p) => p.client_id !== msg.client_id) });
      break;
    case 'project':
      set({ version: msg.version });
      onRemoteProject(msg.project as ProjectMetamodel, msg.author, msg.summary, msg.conflicts || []);
      scheduleActivity();
      break;
    case 'ack':
      set({ version: msg.version });
      if (msg.project) lastSynced = msg.project as ProjectMetamodel;
      if (msg.conflicts?.length)
        banner('error', `Edit conflict on ${msg.conflicts.join(', ')}: a collaborator changed it at the same time — your later edit was kept.`);
      scheduleActivity();
      break;
    case 'error':
      banner('error', msg.message);
      if (lastSynced) {
        applyingRemote = true;
        useModelStore.setState({ project: lastSynced });
        applyingRemote = false;
      }
      break;
    case 'comment':
      set({ comments: [...st.comments.filter((c) => c.id !== msg.comment.id), msg.comment] });
      scheduleActivity();
      break;
    case 'thread':
      set({
        comments: [...st.comments.filter((c) => c.thread_id !== msg.thread_id), ...msg.comments].sort(
          (a, b) => a.id - b.id
        ),
      });
      scheduleActivity();
      break;
    case 'members_changed':
      void st.refreshMembers();
      scheduleActivity();
      break;
  }
}

function open(modelId: string) {
  const token = useModelStore.getState().authToken;
  if (!token) return;
  useCollabStore.setState({ status: 'connecting' });
  const view = useModelStore.getState().workspaceView;
  const ws = new WebSocket(wsUrl(`/collab/ws/${encodeURIComponent(modelId)}?token=${encodeURIComponent(token)}&view=${view}`));
  socket = ws;
  ws.onmessage = (ev) => {
    try {
      handle(JSON.parse(ev.data));
    } catch {
      /* ignore malformed */
    }
  };
  ws.onclose = (ev) => {
    if (socket !== ws) return;
    socket = null;
    useCollabStore.setState({ status: 'offline', peers: [] });
    if (wantedModel === modelId && ev.code !== 4401 && ev.code !== 4403) {
      retry = Math.min(retry + 1, 6);
      retryTimer = setTimeout(() => open(modelId), 500 * 2 ** retry);
    }
  };
}

function subscribeLocal() {
  unsubscribers.forEach((u) => u());
  unsubscribers = [
    useModelStore.subscribe((s, prev) => {
      if (s.project !== prev.project && !applyingRemote && socket) {
        if (sendTimer) clearTimeout(sendTimer);
        sendTimer = setTimeout(flushEdit, 350);
      }
      if (
        s.selectedEntityId !== prev.selectedEntityId ||
        s.selectedColumnId !== prev.selectedColumnId ||
        s.selectedRelationshipId !== prev.selectedRelationshipId ||
        s.workspaceView !== prev.workspaceView
      ) {
        sendPresence();
      }
    }),
  ];
}

export const useCollabStore = create<CollabState>((set, get) => ({
  modelId: null,
  status: 'offline',
  you: null,
  peers: [],
  version: 0,
  myPermission: 'VIEW',
  comments: [],
  activity: [],
  members: [],
  invites: [],
  panelOpen: false,
  panelTab: 'comments',
  commentFocus: null,

  openPanel: (tab, focus = null) => set({ panelOpen: true, panelTab: tab, commentFocus: focus }),
  closePanel: () => set({ panelOpen: false }),

  connect: (modelId) => {
    if (wantedModel === modelId && socket) return;
    get().disconnect();
    wantedModel = modelId;
    retry = 0;
    set({ modelId, comments: [], activity: [], members: [], invites: [] });
    subscribeLocal();
    open(modelId);
  },
  disconnect: () => {
    wantedModel = null;
    if (retryTimer) clearTimeout(retryTimer);
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = null;
    const s = socket;
    socket = null;
    s?.close();
    unsubscribers.forEach((u) => u());
    unsubscribers = [];
    lastSynced = null;
    set({ status: 'offline', peers: [], you: null });
  },

  refreshComments: async () => {
    const id = get().modelId;
    if (!id) return;
    try {
      set({ comments: await rest<CollabComment[]>(`/${encodeURIComponent(id)}/comments`) });
    } catch {
      /* offline */
    }
  },
  refreshActivity: async () => {
    const id = get().modelId;
    if (!id) return;
    try {
      set({ activity: await rest<ActivityItem[]>(`/${encodeURIComponent(id)}/activity?limit=150`) });
    } catch {
      /* offline */
    }
  },
  refreshMembers: async () => {
    const id = get().modelId;
    if (!id) return;
    try {
      const r = await rest<{ my_permission: CollabPermission; members: Member[]; invites: Invite[] }>(
        `/${encodeURIComponent(id)}/members`
      );
      set({ members: r.members, invites: r.invites, myPermission: r.my_permission });
    } catch {
      /* offline */
    }
  },
  addComment: async (body, target, threadId) => {
    const id = get().modelId;
    if (!id) return;
    const c = await rest<CollabComment>(`/${encodeURIComponent(id)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body, thread_id: threadId, ...target }),
    });
    set({ comments: [...get().comments.filter((x) => x.id !== c.id), c] });
  },
  setResolved: async (commentId, resolved) => {
    const rows = await rest<CollabComment[]>(`/comments/${commentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ resolved }),
    });
    const tid = rows[0]?.thread_id;
    set({ comments: [...get().comments.filter((c) => c.thread_id !== tid), ...rows].sort((a, b) => a.id - b.id) });
  },
  deleteComment: async (commentId) => {
    await rest(`/comments/${commentId}`, { method: 'DELETE' });
    set({ comments: get().comments.filter((c) => c.id !== commentId) });
  },
  restore: async (activityId) => {
    const id = get().modelId;
    if (!id) return;
    const r = await rest<{ version: number; project: ProjectMetamodel; summary: string }>(
      `/${encodeURIComponent(id)}/restore/${activityId}`,
      { method: 'POST' }
    );
    set({ version: r.version });
    onRemoteProject(r.project, { name: 'You' }, r.summary);
    await get().refreshActivity();
  },
  invite: async (email, role) => {
    const id = get().modelId;
    if (!id) throw new Error('Not connected');
    const r = await rest<{ link: string; accepted: boolean }>(`/${encodeURIComponent(id)}/invites`, {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    });
    await get().refreshMembers();
    return { link: `${window.location.origin}${r.link}`, accepted: r.accepted };
  },
  revokeInvite: async (token) => {
    await rest(`/invites/${token}`, { method: 'DELETE' });
    await get().refreshMembers();
  },
  setMemberRole: async (email, role) => {
    const id = get().modelId;
    if (!id) return;
    await rest(`/${encodeURIComponent(id)}/members/${encodeURIComponent(email)}`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    });
    await get().refreshMembers();
  },
  acceptInvite: async (token) => {
    const r = await rest<{ model_id: string; permission: CollabPermission }>(`/invites/${token}/accept`, {
      method: 'POST',
    });
    return `You now have ${ROLE_LABEL[r.permission] || r.permission} access to ${
      r.model_id === 'workspace' ? 'this workspace' : r.model_id
    }.`;
  },
}));

/** Open comment threads keyed by entity id (for canvas/dictionary badges). */
export function openThreadCounts(comments: CollabComment[]): Record<string, number> {
  const roots = new Map<string, CollabComment>();
  for (const c of comments) if (!roots.has(c.thread_id)) roots.set(c.thread_id, c);
  const out: Record<string, number> = {};
  for (const c of roots.values()) {
    if (c.resolved || !c.entity_id) continue;
    out[c.entity_id] = (out[c.entity_id] || 0) + 1;
  }
  return out;
}
