import React, { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { TopToolbar } from './components/panels/TopToolbar';
import { LeftExplorer } from './components/panels/LeftExplorer';
import { RightInspector } from './components/panels/RightInspector';
import { CodeDrawer } from './components/panels/CodeDrawer';
import { CompareModal } from './components/panels/CompareModal';
import { ConnectionsModal } from './components/panels/ConnectionsModal';
import { AICompanion } from './components/ai/AICompanion';
import { DataDictionary } from './components/dictionary/DataDictionary';
import { ModelEditor } from './components/editor/ModelEditor';
import type { WorkspaceView } from './store/useModelStore';
import { LoginModal } from './components/auth/LoginModal';
import { ApiKeySettingsModal } from './components/modals/ApiKeySettingsModal';
import { McpIntegrationModal } from './components/modals/McpIntegrationModal';
import { RemoteRepoModal } from './components/modals/RemoteRepoModal';
import { ERDCanvas } from './components/canvas/ERDCanvas';
import { useModelStore } from './store/useModelStore';
import {
  X,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Eye,
  Lock,
  Unlock,
  GitMerge,
  ShieldAlert,
  FolderGit2,
  Network,
  BookOpen,
  FileCode2,
  Columns2,
} from 'lucide-react';

const VIEWS: { id: WorkspaceView; label: string; icon: React.ElementType }[] = [
  { id: 'canvas', label: 'Canvas', icon: Network },
  { id: 'dictionary', label: 'Dictionary', icon: BookOpen },
  { id: 'editor', label: 'Editor', icon: FileCode2 },
  { id: 'split', label: 'Canvas + Editor', icon: Columns2 },
];
import { ErrorBoundary } from './components/common/ErrorBoundary';

export const App: React.FC = () => {
  const loadInitialProject = useModelStore((s) => s.loadInitialProject);
  const statusBanner = useModelStore((s) => s.statusBanner);
  const setStatusBanner = useModelStore((s) => s.setStatusBanner);
  const activeRemoteModel = useModelStore((s) => s.activeRemoteModel);
  const remoteWorkMode = useModelStore((s) => s.remoteWorkMode);
  const currentUser = useModelStore((s) => s.currentUser);
  const checkoutActiveRemoteModel = useModelStore(
    (s) => s.checkoutActiveRemoteModel
  );
  const checkinActiveRemoteModel = useModelStore(
    (s) => s.checkinActiveRemoteModel
  );
  const releaseActiveRemoteModelLock = useModelStore(
    (s) => s.releaseActiveRemoteModelLock
  );
  const reapplyRemoteModelChanges = useModelStore(
    (s) => s.reapplyRemoteModelChanges
  );
  const disconnectFromRemoteRepository = useModelStore(
    (s) => s.disconnectFromRemoteRepository
  );
  const setRemoteRepoModalOpen = useModelStore((s) => s.setRemoteRepoModalOpen);
  const workspaceView = useModelStore((s) => s.workspaceView);
  const setWorkspaceView = useModelStore((s) => s.setWorkspaceView);

  useEffect(() => {
    loadInitialProject();
  }, [loadInitialProject]);

  useEffect(() => {
    if (!statusBanner) return;
    const timer = setTimeout(() => {
      setStatusBanner(null);
    }, 5500);
    return () => clearTimeout(timer);
  }, [statusBanner, setStatusBanner]);

  return (
    <ReactFlowProvider>
      <div className="w-screen h-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
        {/* Top Enterprise Studio Toolbar */}
        <TopToolbar />

        {/* Shared Remote Repository & Checkout Lock Status Bar */}
        {activeRemoteModel && (
          <div
            className={`px-4 py-1.5 border-b text-xs flex flex-wrap items-center justify-between gap-2 shrink-0 ${
              remoteWorkMode === 'checked_out_by_me'
                ? 'bg-emerald-950/40 border-emerald-800/50 text-emerald-200'
                : remoteWorkMode === 'revoked_checkout'
                ? 'bg-amber-950/50 border-amber-700/60 text-amber-200'
                : activeRemoteModel.is_locked
                ? 'bg-slate-900/90 border-amber-800/40 text-slate-300'
                : 'bg-slate-900/80 border-slate-800 text-slate-300'
            }`}
          >
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="font-semibold flex items-center gap-1.5">
                {remoteWorkMode === 'checked_out_by_me' ? (
                  <>
                    <Lock className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-emerald-300">
                      Checked Out &amp; Locked Locally:
                    </span>
                  </>
                ) : remoteWorkMode === 'revoked_checkout' ? (
                  <>
                    <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                    <span className="text-amber-300">
                      Checkout Force-Released by Admin:
                    </span>
                  </>
                ) : (
                  <>
                    <Eye className="w-3.5 h-3.5 text-sky-400" />
                    <span className="text-sky-300">
                      Remote Directory (View-Only Mode):
                    </span>
                  </>
                )}
                <span className="text-white">{activeRemoteModel.name}</span>
                <span className="px-1.5 py-0.2 rounded bg-slate-800 border border-slate-700 font-mono text-[10px] text-indigo-300">
                  {activeRemoteModel.version_tag}
                </span>
              </span>

              <span className="text-slate-400 text-[11px]">
                {remoteWorkMode === 'checked_out_by_me'
                  ? 'Downloaded locally and locked in shared repository — other users are blocked from modifying until you Check In or Release.'
                  : remoteWorkMode === 'revoked_checkout'
                  ? `Your previous lock was force-released (${activeRemoteModel.revoked_session?.force_released_reason || 'Admin override'}). Direct check-in is denied, but your changes are preserved for automatic non-conflicting re-application.`
                  : activeRemoteModel.is_locked
                  ? `Currently checked out and locked by ${activeRemoteModel.checked_out_by_name} (${activeRemoteModel.checked_out_by_email}). Viewing in read-only mode.`
                  : 'Viewing remote model without checkout. Check out the model to download locally and lock for editing.'}
              </span>
            </div>

            <div className="flex items-center gap-2">
              {remoteWorkMode === 'revoked_checkout' &&
                !activeRemoteModel.is_locked && (
                  <button
                    type="button"
                    onClick={() => reapplyRemoteModelChanges()}
                    className="flex items-center gap-1 px-2.5 py-1 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-[11px] shadow-sm transition-colors"
                  >
                    <GitMerge className="w-3 h-3" />
                    <span>Check Out &amp; Auto-Reapply Non-Conflicting Changes</span>
                  </button>
                )}

              {remoteWorkMode !== 'checked_out_by_me' &&
                !activeRemoteModel.is_locked &&
                (activeRemoteModel.user_permission === 'EDIT' ||
                  activeRemoteModel.user_permission === 'ADMIN') && (
                  <button
                    type="button"
                    onClick={() => checkoutActiveRemoteModel()}
                    className="flex items-center gap-1 px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-[11px] transition-colors"
                  >
                    <Lock className="w-3 h-3" />
                    <span>Check Out &amp; Lock</span>
                  </button>
                )}

              {remoteWorkMode === 'checked_out_by_me' && (
                <>
                  <button
                    type="button"
                    onClick={() => checkinActiveRemoteModel()}
                    className="flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-[11px] transition-colors"
                  >
                    <span>Check In &amp; Unlock</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => releaseActiveRemoteModelLock()}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-[11px] transition-colors"
                  >
                    <Unlock className="w-3 h-3" />
                    <span>Release Lock</span>
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={() => setRemoteRepoModalOpen(true)}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-[11px] font-medium transition-colors"
              >
                <FolderGit2 className="w-3 h-3 text-indigo-400" />
                <span>
                  {currentUser.role === 'Admin'
                    ? 'Directory, Force Release & User ACL'
                    : 'Remote Directory'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => disconnectFromRemoteRepository()}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-950 hover:bg-slate-800 text-slate-400 hover:text-white border border-slate-700/80 text-[11px] transition-colors"
                title="Disconnect from Shared Remote Repository and return to Local Standalone Mode"
              >
                <span>Work Locally (Standalone)</span>
              </button>
            </div>
          </div>
        )}

        {/* Status Toast Notification */}
        {statusBanner && (
          <div
            className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl shadow-2xl border text-xs font-medium flex items-center gap-3 backdrop-blur-md transition-all ${
              statusBanner.type === 'error'
                ? 'bg-rose-950/95 border-rose-500 text-rose-200 shadow-rose-950/50'
                : statusBanner.type === 'success'
                ? 'bg-emerald-950/95 border-emerald-500 text-emerald-200 shadow-emerald-950/50'
                : 'bg-slate-900/95 border-violet-500 text-violet-200 shadow-violet-950/50'
            }`}
          >
            {statusBanner.type === 'info' && (
              <Loader2 className="w-4 h-4 animate-spin text-violet-400 shrink-0" />
            )}
            {statusBanner.type === 'success' && (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            )}
            {statusBanner.type === 'error' && (
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            )}
            <span>{statusBanner.message}</span>
            <button
              type="button"
              onClick={() => setStatusBanner(null)}
              className="opacity-70 hover:opacity-100"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Main Workspace Split: LeftExplorer | Canvas / Dictionary / Editor + CodeDrawer | RightInspector | AI Companion */}
        <div className="flex-1 flex min-h-0">
          <LeftExplorer />

          <main className="flex-1 flex flex-col min-w-0 min-h-0 relative">
            <div className="flex items-center gap-1 px-2 py-1 border-b border-slate-800 bg-slate-900/70 shrink-0" data-testid="view-switcher">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setWorkspaceView(v.id)}
                  data-testid={`view-${v.id}`}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    workspaceView === v.id ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  <v.icon className="w-3.5 h-3.5" />
                  {v.label}
                </button>
              ))}
              <span className="ml-auto text-[10px] text-slate-500">
                Canvas · AI Companion · Dictionary · Editor share one live model
              </span>
            </div>
            <div className="flex-1 min-h-0 flex">
              {(workspaceView === 'canvas' || workspaceView === 'split') && (
                <div className={`min-h-0 min-w-0 ${workspaceView === 'split' ? 'w-1/2 border-r border-slate-800' : 'flex-1'}`}>
                  <ERDCanvas />
                </div>
              )}
              {workspaceView === 'dictionary' && (
                <div className="flex-1 min-h-0 min-w-0">
                  <ErrorBoundary fallbackTitle="Dictionary Error">
                    <DataDictionary />
                  </ErrorBoundary>
                </div>
              )}
              {(workspaceView === 'editor' || workspaceView === 'split') && (
                <div className={`min-h-0 min-w-0 ${workspaceView === 'split' ? 'w-1/2' : 'flex-1'}`}>
                  <ErrorBoundary fallbackTitle="Editor Error">
                    <ModelEditor />
                  </ErrorBoundary>
                </div>
              )}
            </div>
            <CodeDrawer />
          </main>

          <RightInspector />
          <ErrorBoundary fallbackTitle="AI Companion Error">
            <AICompanion />
          </ErrorBoundary>
        </div>

        {/* Modals */}
        <ErrorBoundary fallbackTitle="Schema Compare Modal Error">
          <CompareModal />
        </ErrorBoundary>
        <ErrorBoundary fallbackTitle="Database Connections & Ingestion Error">
          <ConnectionsModal />
        </ErrorBoundary>
        <ErrorBoundary fallbackTitle="Authentication Modal Error">
          <LoginModal />
        </ErrorBoundary>
        <ErrorBoundary fallbackTitle="AI API Key Settings Error">
          <ApiKeySettingsModal
            isOpen={useModelStore((s) => s.isApiKeyModalOpen)}
            onClose={() => useModelStore.getState().setApiKeyModalOpen(false)}
          />
        </ErrorBoundary>
        <ErrorBoundary fallbackTitle="MCP Capabilities & Integrations Error">
          <McpIntegrationModal
            isOpen={useModelStore((s) => s.isMcpModalOpen)}
            onClose={() => useModelStore.getState().setMcpModalOpen(false)}
          />
        </ErrorBoundary>
        <ErrorBoundary fallbackTitle="Remote Model Repository & Checkout Error">
          <RemoteRepoModal />
        </ErrorBoundary>
      </div>
    </ReactFlowProvider>
  );
};

export default App;
