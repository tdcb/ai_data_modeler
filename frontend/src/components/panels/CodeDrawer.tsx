import React, { useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import {
  Code2,
  Copy,
  Download,
  RefreshCw,
  X,
  Check,
  FileCode,
} from 'lucide-react';
import { useModelStore } from '../../store/useModelStore';

type DrawerTab = 'snowflake' | 'sql_server' | 'oracle' | 'sqlite' | 'dbt';

export const CodeDrawer: React.FC = () => {
  const isCodeDrawerOpen = useModelStore((s) => s.isCodeDrawerOpen);
  const compiledOutput = useModelStore((s) => s.compiledOutput);
  const isCompiling = useModelStore((s) => s.isCompiling);
  const targetDialect = useModelStore((s) => s.targetDialect);
  const setCodeDrawerOpen = useModelStore((s) => s.setCodeDrawerOpen);
  const refreshCompiledCode = useModelStore((s) => s.refreshCompiledCode);

  const [activeTab, setActiveTab] = useState<DrawerTab>('snowflake');
  const [selectedDbtFile, setSelectedDbtFile] = useState<string>('models/schema.yml');
  const [copied, setCopied] = useState(false);

  // Sync active tab when user changes Target Dialect in TopToolbar
  useEffect(() => {
    if (activeTab !== 'dbt') {
      setActiveTab(targetDialect);
    }
  }, [targetDialect]);

  if (!isCodeDrawerOpen) return null;

  const dbtFiles = compiledOutput?.dbt_files || {};
  const dbtFileKeys = Object.keys(dbtFiles);
  const activeDbtKey = dbtFiles[selectedDbtFile]
    ? selectedDbtFile
    : dbtFileKeys[0] || 'models/schema.yml';

  const getActiveCode = (): string => {
    if (!compiledOutput) return '-- Compiling artifacts...';
    if (activeTab === 'snowflake') return compiledOutput.snowflake_ddl;
    if (activeTab === 'sql_server') return compiledOutput.sql_server_ddl;
    if (activeTab === 'oracle') return compiledOutput.oracle_ddl;
    if (activeTab === 'sqlite') return compiledOutput.sqlite_ddl || '-- Recompile to generate SQLite DDL';
    return dbtFiles[activeDbtKey] || '';
  };

  const editorLanguage =
    activeTab === 'dbt' && activeDbtKey.endsWith('.yml') ? 'yaml' : 'sql';

  const copyCode = () => {
    navigator.clipboard.writeText(getActiveCode());
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const downloadFile = () => {
    const content = getActiveCode();
    const filename =
      activeTab === 'dbt'
        ? activeDbtKey.replace(/\//g, '_')
        : `metaforge_${activeTab}_ddl.sql`;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-80 bg-slate-900 border-t border-slate-800 flex flex-col shrink-0 z-20 shadow-2xl">
      {/* Drawer Header */}
      <div className="px-4 py-2 bg-slate-950 border-b border-slate-800 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Code2 className="w-4 h-4 text-indigo-400" />
          <span className="text-xs font-bold text-white">
            Live Multi-Dialect DDL &amp; dbt Artifact Compiler
          </span>

          <div className="flex items-center gap-1 ml-3">
            {(
              [
                { id: 'snowflake', label: 'Snowflake DDL' },
                { id: 'sql_server', label: 'SQL Server (T-SQL)' },
                { id: 'oracle', label: 'Oracle (PL/SQL)' },
                { id: 'sqlite', label: 'SQLite' },
                { id: 'dbt', label: 'dbt Package (YAML & Jinja SQL)' },
              ] as { id: DrawerTab; label: string }[]
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => refreshCompiledCode()}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs text-slate-200"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isCompiling ? 'animate-spin' : ''}`} />
            <span>Recompile</span>
          </button>

          <button
            type="button"
            onClick={copyCode}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs text-slate-200"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>

          <button
            type="button"
            onClick={downloadFile}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-xs text-white font-semibold"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download</span>
          </button>

          <button
            type="button"
            onClick={() => setCodeDrawerOpen(false)}
            className="text-slate-400 hover:text-white p-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Body: Optional dbt file tree + Monaco Editor */}
      <div className="flex-1 flex min-h-0">
        {activeTab === 'dbt' && (
          <div className="w-60 bg-slate-950 border-r border-slate-800 p-2.5 overflow-y-auto space-y-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 px-2 pb-1">
              workspace_model/exported_dbt/
            </div>
            {dbtFileKeys.map((fileKey) => (
              <button
                key={fileKey}
                type="button"
                onClick={() => setSelectedDbtFile(fileKey)}
                className={`w-full text-left px-2.5 py-1.5 rounded text-xs font-mono flex items-center gap-2 truncate ${
                  activeDbtKey === fileKey
                    ? 'bg-indigo-600/25 text-indigo-300 border border-indigo-500/40'
                    : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                }`}
              >
                <FileCode className="w-3.5 h-3.5 shrink-0 text-indigo-400" />
                <span className="truncate">{fileKey}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 min-w-0">
          <Editor
            height="100%"
            theme="vs-dark"
            language={editorLanguage}
            value={getActiveCode()}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              padding: { top: 10 },
            }}
          />
        </div>
      </div>
    </div>
  );
};
