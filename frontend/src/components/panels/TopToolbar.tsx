import React, { useState, useRef, useEffect } from 'react';
import {
  Database,
  Undo2,
  Redo2,
  LayoutGrid,
  Save,
  GitCompare,
  Upload,
  Code2,
  Sparkles,
  ShieldCheck,
  Eye,
  Layers,
  Cpu,
  Download,
  Image as ImageIcon,
  FileText,
  ChevronDown,
  Key,
  Users,
  LogOut,
  FileSpreadsheet,
  Terminal,
  FolderGit2,
  Lock,
} from 'lucide-react';
import { useModelStore } from '../../store/useModelStore';
import type { TargetDialect, ViewMode } from '../../types/metamodel';
import { exportCanvasDiagram } from '../../utils/canvasExport';
import { api } from '../../services/api';

export const TopToolbar: React.FC = () => {
  const project = useModelStore((s) => s.project);
  const viewMode = useModelStore((s) => s.viewMode);
  const targetDialect = useModelStore((s) => s.targetDialect);
  const pastCount = useModelStore((s) => s.pastProjects.length);
  const futureCount = useModelStore((s) => s.futureProjects.length);
  const isSaving = useModelStore((s) => s.isSaving);
  const currentUser = useModelStore((s) => s.currentUser);
  const authToken = useModelStore((s) => s.authToken);
  const isCodeDrawerOpen = useModelStore((s) => s.isCodeDrawerOpen);
  const isAgentSidebarOpen = useModelStore((s) => s.isAgentSidebarOpen);
  const activeSubjectArea = useModelStore((s) => s.activeSubjectArea);
  const setStatusBanner = useModelStore((s) => s.setStatusBanner);

  // Dropdown states
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const importRef = useRef<HTMLDivElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);

  const setViewMode = useModelStore((s) => s.setViewMode);
  const setTargetDialect = useModelStore((s) => s.setTargetDialect);
  const undo = useModelStore((s) => s.undo);
  const redo = useModelStore((s) => s.redo);
  const saveProjectToServer = useModelStore((s) => s.saveProjectToServer);
  const setCodeDrawerOpen = useModelStore((s) => s.setCodeDrawerOpen);
  const setAgentSidebarOpen = useModelStore((s) => s.setAgentSidebarOpen);
  const openCompareModal = useModelStore((s) => s.openCompareModal);
  const setLoginModalOpen = useModelStore((s) => s.setLoginModalOpen);
  const setApiKeyModalOpen = useModelStore((s) => s.setApiKeyModalOpen);
  const setMcpModalOpen = useModelStore((s) => s.setMcpModalOpen);
  const setRemoteRepoModalOpen = useModelStore((s) => s.setRemoteRepoModalOpen);
  const workspaceMode = useModelStore((s) => s.workspaceMode);
  const activeRemoteModel = useModelStore((s) => s.activeRemoteModel);
  const remoteWorkMode = useModelStore((s) => s.remoteWorkMode);
  const checkoutActiveRemoteModel = useModelStore((s) => s.checkoutActiveRemoteModel);
  const checkinActiveRemoteModel = useModelStore((s) => s.checkinActiveRemoteModel);
  const logout = useModelStore((s) => s.logout);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (importRef.current && !importRef.current.contains(target)) {
        setIsImportOpen(false);
      }
      if (exportRef.current && !exportRef.current.contains(target)) {
        setIsExportOpen(false);
      }
      if (profileRef.current && !profileRef.current.contains(target)) {
        setIsProfileOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const triggerAutoLayout = () => {
    window.dispatchEvent(new CustomEvent('metaforge:auto-layout'));
  };

  const handleDownloadCsv = async () => {
    setIsExportOpen(false);
    try {
      const blob = await api.downloadDataDictionaryCsv(authToken);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_')}_data_dictionary.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setStatusBanner({
        type: 'success',
        message: 'Downloaded enterprise data dictionary CSV.',
      });
    } catch (err: any) {
      setStatusBanner({
        type: 'error',
        message: `CSV export error: ${err.message || err}`,
      });
    }
  };

  const roleBadgeColor =
    currentUser.role === 'Admin'
      ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
      : currentUser.role === 'Data Architect'
      ? 'bg-blue-500/20 text-blue-300 border-blue-500/40'
      : currentUser.role === 'Data Steward'
      ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
      : 'bg-slate-700/60 text-slate-300 border-slate-600';

  const userInitial = (currentUser.full_name || currentUser.email || 'U')[0].toUpperCase();

  return (
    <header className="h-14 px-4 bg-slate-900 border-b border-slate-800 flex items-center justify-between gap-3 shrink-0 z-20">
      {/* Brand + Project Name */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center shadow-md shadow-blue-500/20 shrink-0">
          <Cpu className="w-4 h-4 text-white" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-bold text-sm tracking-tight text-white">
              AI Data Modeler
            </span>
            <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-slate-800 text-blue-400 border border-slate-700">
              v{project.version}
            </span>
          </div>
          <div className="text-[11px] text-slate-400 truncate max-w-[200px]">
            {project.name}
          </div>
        </div>
      </div>

      {/* Center Controls: View Switcher (Logical / Physical / Conceptual) + Dialect + Layout */}
      <div className="flex items-center gap-2.5">
        {/* Duality View Switcher */}
        <div
          className="flex items-center bg-slate-950 p-1 rounded-lg border border-slate-800"
          title="Model level: conceptual (business entities), logical (attributes and keys) or physical (database types and names)"
        >
          <span className="px-1.5 text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Level</span>
          {(
            [
              { id: 'logical', label: 'Logical', icon: Eye },
              { id: 'physical', label: 'Physical', icon: Database },
              { id: 'conceptual', label: 'Conceptual', icon: Layers },
            ] as { id: ViewMode; label: string; icon: React.ElementType }[]
          ).map((item) => {
            const Icon = item.icon;
            const active = viewMode === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setViewMode(item.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                  active
                    ? 'bg-blue-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        {/* Target Physical Dialect Selector */}
        <div className="flex items-center gap-1.5 bg-slate-950 px-2.5 py-1 rounded-lg border border-slate-800">
          <select
            value={targetDialect}
            onChange={(e) => setTargetDialect(e.target.value as TargetDialect)}
            className="bg-transparent text-xs font-semibold text-sky-400 outline-none cursor-pointer"
          >
            <option value="snowflake" className="bg-slate-900 text-slate-100">
              Snowflake
            </option>
            <option value="sql_server" className="bg-slate-900 text-slate-100">
              SQL Server
            </option>
            <option value="oracle" className="bg-slate-900 text-slate-100">
              Oracle
            </option>
          </select>
        </div>

        {/* Undo / Redo & Auto-Layout */}
        <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
          <button
            type="button"
            onClick={undo}
            disabled={pastCount === 0}
            title="Undo (Ctrl+Z)"
            className="p-1.5 rounded text-slate-300 hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={futureCount === 0}
            title="Redo (Ctrl+Y)"
            className="p-1.5 rounded text-slate-300 hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Right Streamlined Actions: Import & Sync | Export | Code | AI Agent | Save | Profile */}
      <div className="flex items-center gap-2">
        {/* 1. Import & Sync Dropdown (Live DB, DDL, Files, Compare) */}
        <div className="relative" ref={importRef}>
          <button
            type="button"
            onClick={() => {
              setIsImportOpen(!isImportOpen);
              setIsExportOpen(false);
              setIsProfileOpen(false);
            }}
            title="Ingest schema from Live Database, SQLite, SQL DDL Script, or File"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              isImportOpen
                ? 'bg-slate-700 text-white border-slate-600'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
            }`}
          >
            <Upload className="w-3.5 h-3.5 text-sky-400" />
            <span>Add data</span>
            <ChevronDown className="w-3 h-3 text-slate-400" />
          </button>

          {isImportOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-64 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 p-1.5 space-y-1 text-xs animate-in fade-in zoom-in-95 duration-100">
              <div className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-slate-400 font-semibold border-b border-slate-800">
                Reverse Engineering &amp; Sync
              </div>

              {/* Live DB & SQLite */}
              <button
                type="button"
                onClick={() => {
                  setIsImportOpen(false);
                  window.dispatchEvent(
                    new CustomEvent('metaforge:open-connections', {
                      detail: { tab: 'reverse' },
                    })
                  );
                }}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-slate-200 hover:bg-slate-800 hover:text-white transition-colors text-left"
              >
                <Database className="w-4 h-4 text-emerald-400 shrink-0" />
                <div>
                  <div className="font-semibold text-xs text-white">
                    Live DB &amp; SQLite
                  </div>
                  <div className="text-[10px] text-slate-400">
                    Reverse engineer tables, multi-zone layers &amp; profile data
                  </div>
                </div>
              </button>

              {/* Paste DDL */}
              <button
                type="button"
                onClick={() => {
                  setIsImportOpen(false);
                  openCompareModal('reverse');
                }}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-slate-200 hover:bg-slate-800 hover:text-white transition-colors text-left"
              >
                <FileText className="w-4 h-4 text-sky-400 shrink-0" />
                <div>
                  <div className="font-semibold text-xs text-white">
                    Paste SQL DDL Script
                  </div>
                  <div className="text-[10px] text-slate-400">
                    Parse Snowflake, T-SQL, or Postgres DDL into canvas
                  </div>
                </div>
              </button>

              {/* Files (Excel / CSV) */}
              <button
                type="button"
                onClick={() => {
                  setIsImportOpen(false);
                  window.dispatchEvent(
                    new CustomEvent('metaforge:open-connections', {
                      detail: { tab: 'files' },
                    })
                  );
                }}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-slate-200 hover:bg-slate-800 hover:text-white transition-colors text-left"
              >
                <FileSpreadsheet className="w-4 h-4 text-amber-400 shrink-0" />
                <div>
                  <div className="font-semibold text-xs text-white">
                    Excel &amp; CSV Workbooks
                  </div>
                  <div className="text-[10px] text-slate-400">
                    Extract multi-worksheet schemas and sample data
                  </div>
                </div>
              </button>

              <div className="border-t border-slate-800 my-1" />

              {/* Complete Compare & ALTER Sync */}
              <button
                type="button"
                onClick={() => {
                  setIsImportOpen(false);
                  openCompareModal('compare');
                }}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-slate-200 hover:bg-slate-800 hover:text-white transition-colors text-left"
              >
                <GitCompare className="w-4 h-4 text-violet-400 shrink-0" />
                <div>
                  <div className="font-semibold text-xs text-white">
                    Compare &amp; ALTER Sync
                  </div>
                  <div className="text-[10px] text-slate-400">
                    Diff model vs DB &amp; generate non-destructive ALTER scripts
                  </div>
                </div>
              </button>
            </div>
          )}
        </div>

        {/* 2. Export Dropdown Menu (PNG / SVG / PDF / CSV) */}
        <div className="relative" ref={exportRef}>
          <button
            type="button"
            onClick={() => {
              setIsExportOpen(!isExportOpen);
              setIsImportOpen(false);
              setIsProfileOpen(false);
            }}
            disabled={isExporting}
            title="Export model canvas as PNG Image, SVG Vector, PDF, or CSV"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              isExportOpen
                ? 'bg-slate-700 text-white border-slate-600'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
            }`}
          >
            <Download className="w-3.5 h-3.5 text-pink-400" />
            <span>{isExporting ? 'Exporting...' : 'Export'}</span>
            <ChevronDown className="w-3 h-3 text-slate-400" />
          </button>

          {isExportOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-60 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 p-1.5 space-y-1 text-xs animate-in fade-in zoom-in-95 duration-100">
              <div className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-slate-400 font-semibold border-b border-slate-800 flex items-center justify-between">
                <span>Export Canvas Model</span>
                <span className="text-[9px] text-slate-500">{activeSubjectArea}</span>
              </div>

              {/* PNG */}
              <button
                type="button"
                onClick={async () => {
                  setIsExportOpen(false);
                  setIsExporting(true);
                  try {
                    await exportCanvasDiagram({
                      projectName: project.name,
                      activeSubjectArea,
                      format: 'png',
                      theme: 'dark',
                    });
                    setStatusBanner({
                      type: 'success',
                      message: 'Exported canvas as high-resolution PNG image.',
                    });
                  } catch (e: any) {
                    setStatusBanner({
                      type: 'error',
                      message: `Export error: ${e?.message || e}`,
                    });
                  } finally {
                    setIsExporting(false);
                  }
                }}
                className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-slate-200 hover:bg-slate-800 hover:text-white transition-colors text-left"
              >
                <ImageIcon className="w-4 h-4 text-emerald-400 shrink-0" />
                <div>
                  <div className="font-semibold text-xs">PNG Image (.png)</div>
                  <div className="text-[10px] text-slate-400">
                    High-res 2x retina raster diagram
                  </div>
                </div>
              </button>

              {/* SVG */}
              <button
                type="button"
                onClick={async () => {
                  setIsExportOpen(false);
                  setIsExporting(true);
                  try {
                    await exportCanvasDiagram({
                      projectName: project.name,
                      activeSubjectArea,
                      format: 'svg',
                      theme: 'dark',
                    });
                    setStatusBanner({
                      type: 'success',
                      message: 'Exported canvas as scalable SVG vector graphic.',
                    });
                  } catch (e: any) {
                    setStatusBanner({
                      type: 'error',
                      message: `Export error: ${e?.message || e}`,
                    });
                  } finally {
                    setIsExporting(false);
                  }
                }}
                className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-slate-200 hover:bg-slate-800 hover:text-white transition-colors text-left"
              >
                <Download className="w-4 h-4 text-sky-400 shrink-0" />
                <div>
                  <div className="font-semibold text-xs">SVG Vector (.svg)</div>
                  <div className="text-[10px] text-slate-400">
                    Infinite zoom vector graphic
                  </div>
                </div>
              </button>

              {/* PDF */}
              <button
                type="button"
                onClick={async () => {
                  setIsExportOpen(false);
                  setIsExporting(true);
                  try {
                    await exportCanvasDiagram({
                      projectName: project.name,
                      activeSubjectArea,
                      format: 'pdf',
                      theme: 'light',
                    });
                    setStatusBanner({
                      type: 'success',
                      message: 'Exported canvas as architecture PDF document.',
                    });
                  } catch (e: any) {
                    setStatusBanner({
                      type: 'error',
                      message: `Export error: ${e?.message || e}`,
                    });
                  } finally {
                    setIsExporting(false);
                  }
                }}
                className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-slate-200 hover:bg-slate-800 hover:text-white transition-colors text-left"
              >
                <FileText className="w-4 h-4 text-rose-400 shrink-0" />
                <div>
                  <div className="font-semibold text-xs">PDF Document (.pdf)</div>
                  <div className="text-[10px] text-slate-400">
                    Landscape architecture printable PDF
                  </div>
                </div>
              </button>

              <div className="border-t border-slate-800 my-1" />

              {/* Data Dictionary CSV */}
              <button
                type="button"
                onClick={handleDownloadCsv}
                className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-slate-200 hover:bg-slate-800 hover:text-white transition-colors text-left"
              >
                <FileSpreadsheet className="w-4 h-4 text-amber-400 shrink-0" />
                <div>
                  <div className="font-semibold text-xs">Data Dictionary (.csv)</div>
                  <div className="text-[10px] text-slate-400">
                    Export column-level business glossary catalog
                  </div>
                </div>
              </button>
            </div>
          )}
        </div>

        {/* 3. DDL & dbt Code Drawer Toggle */}
        <button
          type="button"
          onClick={() => setCodeDrawerOpen(!isCodeDrawerOpen)}
          title="Toggle Multi-Dialect DDL & dbt Code Drawer"
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            isCodeDrawerOpen
              ? 'bg-indigo-600 text-white border-indigo-500 shadow-sm'
              : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
          }`}
        >
          <Code2 className="w-3.5 h-3.5" />
          <span>Code</span>
        </button>

        {/* 4. AI Agent Toggle */}
        <button
          type="button"
          onClick={() => setAgentSidebarOpen(!isAgentSidebarOpen)}
          title="Toggle the AI Companion"
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
            isAgentSidebarOpen
              ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white border-violet-400 shadow-md shadow-violet-500/20'
              : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5 text-violet-300" />
          <span>AI</span>
        </button>

        {/* 6. Shared Remote Model Repository & Check-In / Check-Out */}
        <button
          type="button"
          onClick={() => setRemoteRepoModalOpen(true)}
          title="Connect to Shared Remote Repository or work in Local Standalone Mode"
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors shadow-sm ${
            workspaceMode === 'standalone'
              ? 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
              : remoteWorkMode === 'checked_out_by_me'
              ? 'bg-emerald-950/70 hover:bg-emerald-900/80 text-emerald-300 border-emerald-600/60'
              : remoteWorkMode === 'revoked_checkout'
              ? 'bg-amber-950/80 hover:bg-amber-900/80 text-amber-300 border-amber-500/60'
              : 'bg-indigo-950/70 hover:bg-indigo-900/80 text-indigo-200 border-indigo-600/60'
          }`}
        >
          <FolderGit2 className="w-3.5 h-3.5 text-sky-400" />
          <span>Repository</span>
          <span
            className={`px-1.5 py-0.2 rounded text-[9px] font-bold uppercase ${
              workspaceMode === 'standalone'
                ? 'bg-slate-700 text-slate-300'
                : remoteWorkMode === 'checked_out_by_me'
                ? 'bg-emerald-500/25 text-emerald-200'
                : remoteWorkMode === 'revoked_checkout'
                ? 'bg-amber-500/25 text-amber-200'
                : 'bg-indigo-500/30 text-indigo-200'
            }`}
          >
            {workspaceMode === 'standalone'
              ? 'Standalone'
              : remoteWorkMode === 'checked_out_by_me'
              ? 'Locked by You'
              : remoteWorkMode === 'revoked_checkout'
              ? 'Force-Released'
              : 'View-Only'}
          </span>
        </button>

        {/* 7. Context-Aware Save (Standalone) vs Check Out / Save Draft / Check In (Remote) */}
        {workspaceMode === 'standalone' ? (
          <button
            type="button"
            onClick={() => saveProjectToServer()}
            disabled={isSaving || currentUser.role === 'Viewer'}
            title="Save canonical model changes to local workspace (Ctrl+S)"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow disabled:opacity-40 transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{isSaving ? 'Saving...' : 'Save'}</span>
          </button>
        ) : activeRemoteModel && remoteWorkMode !== 'checked_out_by_me' ? (
          <button
            type="button"
            onClick={() => {
              if (
                activeRemoteModel.is_locked &&
                activeRemoteModel.checked_out_by_email?.toLowerCase() !==
                  currentUser.email.toLowerCase()
              ) {
                setRemoteRepoModalOpen(true);
              } else if (remoteWorkMode === 'revoked_checkout') {
                setRemoteRepoModalOpen(true);
              } else {
                checkoutActiveRemoteModel();
              }
            }}
            disabled={
              currentUser.role === 'Viewer' &&
              activeRemoteModel.user_permission === 'VIEW'
            }
            title={
              activeRemoteModel.is_locked
                ? `Checked out by ${activeRemoteModel.checked_out_by_name} (${activeRemoteModel.checked_out_by_email})`
                : 'Check out model from shared repository to download locally and lock for editing'
            }
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow disabled:opacity-40 transition-colors"
          >
            <Lock className="w-3.5 h-3.5" />
            <span>
              {activeRemoteModel.is_locked
                ? `Locked (${activeRemoteModel.checked_out_by_name?.split(' ')[0] || 'User'})`
                : remoteWorkMode === 'revoked_checkout'
                ? 'Re-Apply Changes'
                : 'Check Out & Lock'}
            </span>
          </button>
        ) : (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => saveProjectToServer()}
              disabled={isSaving || currentUser.role === 'Viewer'}
              title="Save local checkout draft (Ctrl+S)"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-600/40 shadow disabled:opacity-40 transition-colors"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isSaving ? 'Saving...' : 'Save Draft'}</span>
            </button>
            {activeRemoteModel && (
              <button
                type="button"
                onClick={() => checkinActiveRemoteModel()}
                disabled={isSaving}
                title="Check in local changes to shared remote repository and release lock"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow disabled:opacity-40 transition-colors"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Check In</span>
              </button>
            )}
          </div>
        )}

        {/* 6. User Profile & Settings Menu Dropdown */}
        <div className="relative" ref={profileRef}>
          <button
            type="button"
            onClick={() => {
              setIsProfileOpen(!isProfileOpen);
              setIsImportOpen(false);
              setIsExportOpen(false);
            }}
            title="User Profile & Settings"
            className="flex items-center gap-2 p-1 pl-1.5 pr-2 rounded-lg bg-slate-950 border border-slate-800 hover:border-slate-700 transition-colors"
          >
            <div className="w-6 h-6 rounded-md bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-[11px] font-bold text-white shadow-sm">
              {userInitial}
            </div>
            <div className="text-left hidden sm:block">
              <div className="text-[11px] font-semibold text-slate-200 leading-tight truncate max-w-[90px]">
                {currentUser.full_name?.split(' ')[0] || currentUser.email}
              </div>
              <div className="text-[9px] text-slate-400 leading-none">
                {currentUser.role}
              </div>
            </div>
            <ChevronDown className="w-3 h-3 text-slate-400" />
          </button>

          {isProfileOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-64 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 p-2 space-y-1.5 text-xs animate-in fade-in zoom-in-95 duration-100">
              {/* User Header */}
              <div className="p-2 rounded-lg bg-slate-950/60 border border-slate-800 space-y-1">
                <div className="font-semibold text-white truncate">
                  {currentUser.full_name}
                </div>
                <div className="text-[11px] font-mono text-slate-400 truncate">
                  {currentUser.email}
                </div>
                <div className="pt-0.5">
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold border ${roleBadgeColor}`}
                  >
                    {currentUser.role}
                  </span>
                </div>
              </div>

              {/* Menu Actions */}
              <div className="space-y-0.5 pt-1">
                {/* AI API Keys */}
                <button
                  type="button"
                  onClick={() => {
                    setIsProfileOpen(false);
                    setApiKeyModalOpen(true);
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-slate-200 hover:bg-slate-800 hover:text-white transition-colors text-left"
                >
                  <Key className="w-4 h-4 text-sky-400 shrink-0" />
                  <div>
                    <div className="font-medium text-xs text-white">
                      AI API Keys (Gemini)
                    </div>
                    <div className="text-[10px] text-slate-400">
                      Configure your private Google Gemini key
                    </div>
                  </div>
                </button>

                {/* MCP Server & Coding Assistants */}
                <button
                  type="button"
                  onClick={() => {
                    setIsProfileOpen(false);
                    setMcpModalOpen(true);
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-slate-200 hover:bg-slate-800 hover:text-white transition-colors text-left"
                >
                  <Terminal className="w-4 h-4 text-indigo-400 shrink-0" />
                  <div>
                    <div className="font-medium text-xs text-white">
                      MCP Coding Assistants
                    </div>
                    <div className="text-[10px] text-slate-400">
                      Claude Code, Cursor, Kiro, Gemini CLI
                    </div>
                  </div>
                </button>

                {/* User Directory & RBAC */}
                <button
                  type="button"
                  onClick={() => {
                    setIsProfileOpen(false);
                    setLoginModalOpen(true);
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-slate-200 hover:bg-slate-800 hover:text-white transition-colors text-left"
                >
                  <Users className="w-4 h-4 text-emerald-400 shrink-0" />
                  <div>
                    <div className="font-medium text-xs text-white">
                      User Directory &amp; RBAC
                    </div>
                    <div className="text-[10px] text-slate-400">
                      Manage team roles &amp; switch user session
                    </div>
                  </div>
                </button>

                <div className="border-t border-slate-800 my-1" />

                {/* Sign Out */}
                <button
                  type="button"
                  onClick={() => {
                    setIsProfileOpen(false);
                    logout();
                    setLoginModalOpen(true);
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-rose-400 hover:bg-rose-950/40 hover:text-rose-300 transition-colors text-left"
                >
                  <LogOut className="w-3.5 h-3.5 shrink-0" />
                  <span className="font-medium text-xs">Switch User / Sign Out</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
