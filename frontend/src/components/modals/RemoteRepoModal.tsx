import React, { useState, useEffect } from 'react';
import {
  Cloud,
  Lock,
  Unlock,
  Eye,
  Download,
  Upload,
  ShieldAlert,
  Users,
  GitMerge,
  Plus,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  X,
  FolderGit2,
  Clock,
  UserCheck,
  Shield,
} from 'lucide-react';
import { useModelStore } from '../../store/useModelStore';
import { api } from '../../services/api';
import type {
  ModelAccessEntry,
  RemoteModelSummary,
  RemotePermission,
} from '../../types/metamodel';

export const RemoteRepoModal: React.FC = () => {
  const isOpen = useModelStore((s) => s.isRemoteRepoModalOpen);
  const setOpen = useModelStore((s) => s.setRemoteRepoModalOpen);

  const remoteModels = useModelStore((s) => s.remoteModels);
  const workspaceMode = useModelStore((s) => s.workspaceMode);
  const remoteRepoUrl = useModelStore((s) => s.remoteRepoUrl);
  const activeRemoteModel = useModelStore((s) => s.activeRemoteModel);
  const remoteWorkMode = useModelStore((s) => s.remoteWorkMode);
  const currentUser = useModelStore((s) => s.currentUser);
  const authToken = useModelStore((s) => s.authToken);
  const project = useModelStore((s) => s.project);
  const lastMergeReport = useModelStore((s) => s.lastMergeReport);
  const clearMergeReport = useModelStore((s) => s.clearMergeReport);

  const connectToRemoteRepository = useModelStore(
    (s) => s.connectToRemoteRepository
  );
  const disconnectFromRemoteRepository = useModelStore(
    (s) => s.disconnectFromRemoteRepository
  );
  const refreshRemoteModels = useModelStore((s) => s.refreshRemoteModels);
  const openRemoteModelViewOnly = useModelStore((s) => s.openRemoteModelViewOnly);
  const checkoutActiveRemoteModel = useModelStore((s) => s.checkoutActiveRemoteModel);
  const checkinActiveRemoteModel = useModelStore((s) => s.checkinActiveRemoteModel);
  const releaseActiveRemoteModelLock = useModelStore(
    (s) => s.releaseActiveRemoteModelLock
  );
  const forceReleaseRemoteModel = useModelStore((s) => s.forceReleaseRemoteModel);
  const reapplyRemoteModelChanges = useModelStore(
    (s) => s.reapplyRemoteModelChanges
  );
  const setStatusBanner = useModelStore((s) => s.setStatusBanner);

  const [activeTab, setActiveTab] = useState<'directory' | 'acl' | 'create'>(
    'directory'
  );
  const [isLoading, setIsLoading] = useState(false);
  const [repoUrlInput] = useState(remoteRepoUrl);

  // Check-in dialog state
  const [checkinModelId, setCheckinModelId] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState(
    'Updated canonical entities, relationships, and governance metadata'
  );

  // Force-release dialog state
  const [forceReleaseModelId, setForceReleaseModelId] = useState<string | null>(
    null
  );
  const [forceReleaseReason, setForceReleaseReason] = useState(
    'Administrative lock release required for priority model update'
  );

  // ACL management state
  const [selectedAclModelId, setSelectedAclModelId] = useState<string>(
    'model-enterprise-insurance'
  );
  const [aclEntries, setAclEntries] = useState<ModelAccessEntry[]>([]);
  const [isSavingAcl, setIsSavingAcl] = useState(false);

  // Create new remote model state
  const [newModelName, setNewModelName] = useState('');
  const [newModelDesc, setNewModelDesc] = useState('');
  const [seedFromCurrentCanvas, setSeedFromCurrentCanvas] = useState(true);

  useEffect(() => {
    if (isOpen) {
      refreshRemoteModels();
      if (activeRemoteModel?.id) {
        setSelectedAclModelId(activeRemoteModel.id);
      }
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && activeTab === 'acl' && selectedAclModelId) {
      loadAcl(selectedAclModelId);
    }
  }, [isOpen, activeTab, selectedAclModelId]);

  if (!isOpen) return null;

  const isAdmin = currentUser.role === 'Admin';

  const loadAcl = async (modelId: string) => {
    setIsLoading(true);
    try {
      const entries = await api.getRemoteModelAccess(modelId, authToken);
      setAclEntries(entries);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Failed to load model access list';
      setStatusBanner({ type: 'error', message: msg });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveAcl = async () => {
    if (!selectedAclModelId) return;
    setIsSavingAcl(true);
    try {
      const updated = await api.updateRemoteModelAccess(
        selectedAclModelId,
        aclEntries,
        authToken
      );
      setAclEntries(updated);
      await refreshRemoteModels();
      setStatusBanner({
        type: 'success',
        message: 'Updated user access permissions for remote model.',
      });
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Failed to update access list';
      setStatusBanner({ type: 'error', message: msg });
    } finally {
      setIsSavingAcl(false);
    }
  };

  const handleCreateRemoteModel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newModelName.trim()) return;
    setIsLoading(true);
    try {
      const created = await api.createRemoteModel(
        newModelName.trim(),
        newModelDesc.trim() ||
          'Shared canonical data model in enterprise repository',
        seedFromCurrentCanvas ? project : null,
        authToken
      );
      await refreshRemoteModels();
      await openRemoteModelViewOnly(created.id);
      setNewModelName('');
      setNewModelDesc('');
      setActiveTab('directory');
      setStatusBanner({
        type: 'success',
        message: `Published '${created.name}' to the Shared Remote Repository.`,
      });
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Failed to create remote model';
      setStatusBanner({ type: 'error', message: msg });
    } finally {
      setIsLoading(false);
    }
  };

  const renderPermissionBadge = (perm: RemotePermission) => {
    const colors: Record<RemotePermission, string> = {
      ADMIN: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
      EDIT: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
      VIEW: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
      NONE: 'bg-slate-700/50 text-slate-400 border-slate-600',
    };
    return (
      <span
        className={`px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded border ${colors[perm] || colors.VIEW}`}
      >
        Access: {perm}
      </span>
    );
  };

  const isLockedByMe = (m: RemoteModelSummary) =>
    m.is_locked &&
    Boolean(
      m.checked_out_by_email &&
        m.checked_out_by_email.toLowerCase() === currentUser.email.toLowerCase()
    );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700/80 rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-slate-950/60 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-indigo-500/15 border border-indigo-500/30 text-indigo-400">
              <FolderGit2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                Shared Remote Model Repository & Check-In / Check-Out Governance
              </h2>
              <p className="text-xs text-slate-400">
                Browse remote models in View-Only mode, Check Out to download locally & lock, manage User Access (ACL), or Force-Release & Auto-Reapply non-conflicting changes
              </p>
            </div>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center justify-between px-6 py-2.5 bg-slate-900 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('directory')}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeTab === 'directory'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              <Cloud className="w-3.5 h-3.5" />
              Remote Directory ({remoteModels.length})
            </button>
            <button
              onClick={() => setActiveTab('acl')}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeTab === 'acl'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              <Users className="w-3.5 h-3.5" />
              User Access Control (Admin ACL)
            </button>
            {(currentUser.role === 'Admin' ||
              currentUser.role === 'Data Architect') && (
              <button
                onClick={() => setActiveTab('create')}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  activeTab === 'create'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
              >
                <Plus className="w-3.5 h-3.5" />
                Publish New Remote Model
              </button>
            )}
          </div>

          <button
            onClick={() => refreshRemoteModels()}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-slate-700 bg-slate-800/70 hover:bg-slate-800 text-xs text-slate-300"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh Status
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Standalone vs. Remote Repository Connection Control Panel */}
          <div
            className={`rounded-xl border p-4 flex flex-wrap items-center justify-between gap-4 ${
              workspaceMode === 'remote'
                ? 'border-indigo-500/40 bg-indigo-950/20'
                : 'border-slate-700 bg-slate-950/70'
            }`}
          >
            <div className="space-y-1 flex-1 min-w-[260px]">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Current Modeling Mode:
                </span>
                {workspaceMode === 'remote' ? (
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 flex items-center gap-1.5">
                    <Cloud className="w-3.5 h-3.5 text-indigo-400" />
                    Connected to Remote Repository ({activeRemoteModel?.name || 'Active'})
                  </span>
                ) : (
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                    Local Standalone Mode (Unrestricted Local Workspace)
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400">
                {workspaceMode === 'remote'
                  ? 'You are connected to the Shared Remote Repository. Models open in View-Only mode unless you Check Out & Lock them locally. You can switch back to Local Standalone Mode at any time.'
                  : 'By default, you work locally in Standalone Mode with unrestricted editing. Initiate a connection to the Remote Repository below (or open any remote model) to work with shared check-in/check-out governance.'}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={repoUrlInput}
                readOnly
                title="Shared models are stored centrally on this server"
                className="w-64 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500"
              />
              {workspaceMode === 'standalone' ? (
                <button
                  type="button"
                  onClick={async () => {
                    await connectToRemoteRepository(repoUrlInput);
                  }}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-sm transition-colors"
                >
                  <Cloud className="w-3.5 h-3.5" />
                  Connect to Remote Repo
                </button>
              ) : (
                <button
                  type="button"
                  onClick={async () => {
                    await disconnectFromRemoteRepository();
                    setOpen(false);
                  }}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold transition-colors"
                >
                  Switch to Standalone (Local Mode)
                </button>
              )}
            </div>
          </div>

          {/* 3-Way Merge Report Banner if recently executed */}
          {lastMergeReport && (
            <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/25 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-emerald-300 font-semibold text-sm">
                  <GitMerge className="w-4 h-4" />
                  <span>
                    3-Way Auto-Reapply Report (Base v1.0.
                    {Math.max(0, lastMergeReport.base_version - 1)} &rarr; Latest
                    Remote v1.0.
                    {Math.max(0, lastMergeReport.target_remote_version - 1)})
                  </span>
                </div>
                <button
                  onClick={clearMergeReport}
                  className="text-xs text-slate-400 hover:text-slate-200"
                >
                  Dismiss
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="bg-slate-900/80 border border-emerald-500/30 rounded-lg p-3">
                  <div className="font-semibold text-emerald-300 mb-1.5 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Non-Conflicting Changes Automatically Re-Applied (
                    {lastMergeReport.applied_changes.length})
                  </div>
                  {lastMergeReport.applied_changes.length === 0 ? (
                    <p className="text-slate-400 italic">
                      No additional non-conflicting changes detected.
                    </p>
                  ) : (
                    <ul className="space-y-1 text-slate-300 list-disc list-inside">
                      {lastMergeReport.applied_changes.map((item, idx) => (
                        <li key={idx}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="bg-slate-900/80 border border-amber-500/30 rounded-lg p-3">
                  <div className="font-semibold text-amber-300 mb-1.5 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Conflicting Changes Skipped (Kept Latest Remote) (
                    {lastMergeReport.conflicts_skipped.length})
                  </div>
                  {lastMergeReport.conflicts_skipped.length === 0 ? (
                    <p className="text-slate-400 italic">
                      Zero conflicts! All of your changes merged cleanly.
                    </p>
                  ) : (
                    <ul className="space-y-1 text-amber-200/90 list-disc list-inside">
                      {lastMergeReport.conflicts_skipped.map((item, idx) => (
                        <li key={idx}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 1: REMOTE DIRECTORY */}
          {activeTab === 'directory' && (
            <div className="space-y-4">
              {remoteModels.map((m) => {
                const isActive = activeRemoteModel?.id === m.id;
                const lockedByCurrentUser = isLockedByMe(m);
                const canEdit =
                  m.user_permission === 'EDIT' || m.user_permission === 'ADMIN';

                return (
                  <div
                    key={m.id}
                    className={`rounded-xl border p-5 transition-all ${
                      isActive
                        ? 'border-indigo-500/70 bg-slate-800/60 shadow-lg'
                        : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2.5 flex-wrap">
                          <span className="text-base font-bold text-white">
                            {m.name}
                          </span>
                          <span className="px-2 py-0.5 text-[11px] font-mono rounded bg-slate-800 text-indigo-300 border border-slate-700">
                            {m.version_tag}
                          </span>
                          {renderPermissionBadge(m.user_permission)}
                          {isActive && (
                            <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
                              Active in Canvas ({remoteWorkMode === 'checked_out_by_me' ? 'Checked Out Locally' : 'View-Only'})
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-400">{m.description}</p>
                        <div className="flex items-center gap-4 text-[11px] text-slate-400 pt-1">
                          <span>
                            <strong>{m.entity_count}</strong> Entities / Views
                          </span>
                          <span>
                            <strong>{m.relationship_count}</strong> Relationships
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            Updated:{' '}
                            {m.updated_at
                              ? new Date(m.updated_at).toLocaleString()
                              : 'Just now'}
                          </span>
                        </div>
                      </div>

                      {/* Lock Status Pill */}
                      <div className="flex flex-col items-end gap-1.5">
                        {m.is_locked ? (
                          lockedByCurrentUser ? (
                            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-xs font-medium">
                              <Lock className="w-3.5 h-3.5" />
                              Checked Out & Locked by You
                            </div>
                          ) : (
                            <div className="flex flex-col items-end">
                              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/40 text-amber-300 text-xs font-medium">
                                <Lock className="w-3.5 h-3.5" />
                                Checked Out by {m.checked_out_by_name} (
                                {m.checked_out_by_email})
                              </div>
                              <span className="text-[10px] text-slate-400 mt-1">
                                Contact {m.checked_out_by_name} to release, or ask
                                Admin to Force Release
                              </span>
                            </div>
                          )
                        ) : (
                          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 text-xs font-medium">
                            <Unlock className="w-3.5 h-3.5 text-emerald-400" />
                            Available in Shared Repo (Unlocked)
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Force-Released Session Notice & Auto-Reapply Banner */}
                    {m.revoked_session && (
                      <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-950/30 p-3.5 flex flex-wrap items-center justify-between gap-3">
                        <div className="space-y-1 max-w-2xl">
                          <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                            <ShieldAlert className="w-4 h-4 shrink-0" />
                            Your Previous Checkout Lock (Base v1.0.
                            {Math.max(0, m.revoked_session.base_version - 1)}) Was
                            Force-Released by Admin (
                            {m.revoked_session.force_released_by_email || 'admin'})
                          </div>
                          <p className="text-[11px] text-amber-200/80">
                            Reason:{' '}
                            <em>
                              &ldquo;
                              {m.revoked_session.force_released_reason ||
                                'Administrative lock release'}
                              &rdquo;
                            </em>
                            . Direct check-in of that stale checkout is denied, but
                            your local changes were preserved!{' '}
                            {m.is_locked && !lockedByCurrentUser
                              ? `Wait until ${m.checked_out_by_name} releases the lock, then click 'Check Out & Auto-Reapply Non-Conflicting Changes'.`
                              : `The model is now available! Click 'Check Out & Auto-Reapply Non-Conflicting Changes' to merge your edits onto ${m.version_tag}.`}
                          </p>
                        </div>
                        <button
                          disabled={m.is_locked && !lockedByCurrentUser}
                          onClick={async () => {
                            await reapplyRemoteModelChanges(m.id);
                          }}
                          className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all ${
                            m.is_locked && !lockedByCurrentUser
                              ? 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed'
                              : 'bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-md'
                          }`}
                        >
                          <GitMerge className="w-4 h-4" />
                          Check Out & Auto-Reapply Non-Conflicting Changes
                        </button>
                      </div>
                    )}

                    {/* Action Toolbar for this Model */}
                    <div className="mt-4 pt-3.5 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        {/* View Only Button (always available without checkout!) */}
                        <button
                          onClick={async () => {
                            await openRemoteModelViewOnly(m.id);
                            setOpen(false);
                          }}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium transition-colors"
                        >
                          <Eye className="w-3.5 h-3.5 text-sky-400" />
                          Open View-Only (No Checkout)
                        </button>

                        {/* Check Out & Lock Locally */}
                        {!lockedByCurrentUser && (
                          <button
                            disabled={m.is_locked || !canEdit}
                            onClick={async () => {
                              const ok = await checkoutActiveRemoteModel(m.id);
                              if (ok) setOpen(false);
                            }}
                            title={
                              !canEdit
                                ? 'Requires EDIT or ADMIN permission from Admin'
                                : m.is_locked
                                  ? `Currently locked by ${m.checked_out_by_name}`
                                  : 'Download model locally and lock in shared repository'
                            }
                            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                              m.is_locked || !canEdit
                                ? 'bg-slate-800/50 text-slate-500 border border-slate-800 cursor-not-allowed'
                                : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm'
                            }`}
                          >
                            <Download className="w-3.5 h-3.5" />
                            Check Out & Lock Locally
                          </button>
                        )}

                        {/* If Checked Out by Current User: Check In & Release buttons */}
                        {lockedByCurrentUser && (
                          <>
                            <button
                              onClick={() => {
                                setCheckinModelId(m.id);
                              }}
                              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-sm transition-colors"
                            >
                              <Upload className="w-3.5 h-3.5" />
                              Check In Changes & Unlock
                            </button>

                            <button
                              onClick={async () => {
                                await releaseActiveRemoteModelLock(m.id);
                              }}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs font-medium transition-colors"
                            >
                              <Unlock className="w-3.5 h-3.5 text-slate-400" />
                              Release Lock (Discard Uncommitted)
                            </button>
                          </>
                        )}
                      </div>

                      {/* Admin Force Release Button */}
                      {m.is_locked &&
                        (currentUser.role === 'Admin' ||
                          m.user_permission === 'ADMIN') && (
                          <button
                            onClick={() => {
                              setForceReleaseModelId(m.id);
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/40 text-xs font-semibold transition-colors"
                          >
                            <ShieldAlert className="w-3.5 h-3.5" />
                            Admin Force Release Lock
                          </button>
                        )}
                    </div>

                    {/* Inline Check-In Prompt */}
                    {checkinModelId === m.id && (
                      <div className="mt-3 p-3.5 rounded-lg bg-slate-950/90 border border-emerald-500/40 space-y-2.5">
                        <div className="text-xs font-semibold text-emerald-300">
                          Check In Local Modifications to Shared Repository ({m.name})
                        </div>
                        <input
                          type="text"
                          value={commitMessage}
                          onChange={(e) => setCommitMessage(e.target.value)}
                          placeholder="Enter check-in commit message..."
                          className="w-full px-3 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs text-white focus:outline-none focus:border-emerald-500"
                        />
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => setCheckinModelId(null)}
                            className="px-3 py-1 rounded text-xs text-slate-400 hover:text-white"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={async () => {
                              const ok = await checkinActiveRemoteModel(
                                commitMessage,
                                m.id
                              );
                              setCheckinModelId(null);
                              if (ok) setOpen(false);
                            }}
                            className="px-3.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold"
                          >
                            Confirm Check-In & Release Lock
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Inline Admin Force-Release Prompt */}
                    {forceReleaseModelId === m.id && (
                      <div className="mt-3 p-3.5 rounded-lg bg-rose-950/30 border border-rose-500/40 space-y-2.5">
                        <div className="text-xs font-semibold text-rose-300 flex items-center gap-1.5">
                          <ShieldAlert className="w-4 h-4" />
                          Force Release Lock Held by {m.checked_out_by_name} (
                          {m.checked_out_by_email})
                        </div>
                        <p className="text-[11px] text-slate-300">
                          Force-releasing will immediately unlock the model in the
                          shared repository and <strong>deny</strong>{' '}
                          {m.checked_out_by_name} the ability to check in this
                          session directly. Their in-progress draft will be
                          preserved so they can automatically re-apply
                          non-conflicting changes when the model is available for
                          checkout again.
                        </p>
                        <input
                          type="text"
                          value={forceReleaseReason}
                          onChange={(e) => setForceReleaseReason(e.target.value)}
                          placeholder="Reason for administrative force release..."
                          className="w-full px-3 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs text-white focus:outline-none focus:border-rose-500"
                        />
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => setForceReleaseModelId(null)}
                            className="px-3 py-1 rounded text-xs text-slate-400 hover:text-white"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={async () => {
                              await forceReleaseRemoteModel(
                                m.id,
                                forceReleaseReason
                              );
                              setForceReleaseModelId(null);
                            }}
                            className="px-3.5 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold"
                          >
                            Confirm Force Release
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* TAB 2: ADMIN USER ACCESS CONTROL (ACL) */}
          {activeTab === 'acl' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4 bg-slate-950/60 p-4 rounded-xl border border-slate-800">
                <div className="space-y-1">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Shield className="w-4 h-4 text-indigo-400" />
                    Model-Level User Access Control Matrix
                  </h3>
                  <p className="text-xs text-slate-400">
                    Admin-controlled permissions determine who can view, check
                    out/edit, or administer each model in the shared repository.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-400">Target Model:</label>
                  <select
                    value={selectedAclModelId}
                    onChange={(e) => setSelectedAclModelId(e.target.value)}
                    className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-white"
                  >
                    {remoteModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} ({m.version_tag})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 overflow-hidden">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-950/80 text-slate-400 border-b border-slate-800">
                      <th className="py-2.5 px-4">User Name</th>
                      <th className="py-2.5 px-4">Email</th>
                      <th className="py-2.5 px-4">Enterprise Role</th>
                      <th className="py-2.5 px-4">Remote Model Access Level</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {aclEntries.map((entry, idx) => (
                      <tr
                        key={entry.user_email}
                        className="hover:bg-slate-800/40 transition-colors"
                      >
                        <td className="py-2.5 px-4 font-medium text-slate-200 flex items-center gap-2">
                          <UserCheck className="w-3.5 h-3.5 text-indigo-400" />
                          {entry.full_name}
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-400">
                          {entry.user_email}
                        </td>
                        <td className="py-2.5 px-4 text-slate-300">
                          {entry.user_role}
                        </td>
                        <td className="py-2.5 px-4">
                          <select
                            disabled={!isAdmin || entry.user_role === 'Admin'}
                            value={entry.permission}
                            onChange={(e) => {
                              const next = [...aclEntries];
                              next[idx] = {
                                ...entry,
                                permission: e.target.value as RemotePermission,
                              };
                              setAclEntries(next);
                            }}
                            className="px-2.5 py-1 rounded bg-slate-950 border border-slate-700 text-xs text-slate-200 disabled:opacity-60"
                          >
                            <option value="ADMIN">
                              ADMIN (Full Control + Force Release + ACL)
                            </option>
                            <option value="EDIT">
                              EDIT (View + Check Out & Lock + Check In)
                            </option>
                            <option value="VIEW">
                              VIEW (View-Only Without Checkout)
                            </option>
                            <option value="NONE">
                              NONE (Hidden / No Access)
                            </option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-xs text-slate-400">
                  {isAdmin
                    ? 'Changes take effect immediately across all active sessions.'
                    : 'Only Enterprise Admins can modify user access permissions.'}
                </span>
                {isAdmin && (
                  <button
                    disabled={isSavingAcl || isLoading}
                    onClick={handleSaveAcl}
                    className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-sm"
                  >
                    {isSavingAcl ? 'Saving Access Policy...' : 'Save Access Control List'}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: CREATE / PUBLISH NEW REMOTE MODEL */}
          {activeTab === 'create' && (
            <form
              onSubmit={handleCreateRemoteModel}
              className="max-w-xl mx-auto space-y-4 bg-slate-950/60 p-5 rounded-xl border border-slate-800"
            >
              <h3 className="text-sm font-bold text-white">
                Publish Model to Shared Remote Repository
              </h3>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">
                  Remote Model Name
                </label>
                <input
                  type="text"
                  required
                  value={newModelName}
                  onChange={(e) => setNewModelName(e.target.value)}
                  placeholder="e.g., Commercial Lines & Actuarial Data Mart"
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">
                  Business Description
                </label>
                <textarea
                  rows={3}
                  value={newModelDesc}
                  onChange={(e) => setNewModelDesc(e.target.value)}
                  placeholder="Describe the domain scope, stewardship team, and target warehouse layers..."
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={seedFromCurrentCanvas}
                  onChange={(e) => setSeedFromCurrentCanvas(e.target.checked)}
                  className="rounded border-slate-700"
                />
                Initialize with entities and relationships from current Studio
                Canvas
              </label>
              <div className="flex justify-end pt-2">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-sm"
                >
                  {isLoading
                    ? 'Publishing...'
                    : 'Publish Model to Shared Repository'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
