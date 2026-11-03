import React, { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, Save, Zap } from 'lucide-react';
import { useModelStore } from '../../store/useModelStore';
import { aiApi } from '../../services/aiApi';
import type { ProjectMetamodel } from '../../types/metamodel';

type MonacoNs = Parameters<OnMount>[1];
type EditorInst = Parameters<OnMount>[0];

/** Code-level editor: a DBML-style view of the model that round-trips into the shared canonical model. */
export const ModelEditor: React.FC = () => {
  const project = useModelStore((s) => s.project);
  const setProject = useModelStore((s) => s.setProject);
  const targetDialect = useModelStore((s) => s.targetDialect);
  const authToken = useModelStore((s) => s.authToken);
  const refreshCompiledCode = useModelStore((s) => s.refreshCompiledCode);

  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ line: number; message: string }[]>([]);
  const [lastChanges, setLastChanges] = useState<string[]>([]);
  const producedRef = useRef<ProjectMetamodel | null>(null);
  const editorRef = useRef<EditorInst | null>(null);
  const monacoRef = useRef<MonacoNs | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const render = useCallback(async () => {
    try {
      const res = await aiApi.editorRender(project, targetDialect, authToken);
      setText(res.text);
      setDirty(false);
      setErrors([]);
    } catch (e) {
      setErrors([{ line: 1, message: e instanceof Error ? e.message : String(e) }]);
    }
  }, [project, targetDialect, authToken]);

  // Pull changes made in the Canvas / Dictionary / AI Companion, unless they came from this editor.
  useEffect(() => {
    if (producedRef.current === project) return;
    if (dirty) return;
    render();
  }, [project, targetDialect]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const m = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!m || !model) return;
    m.editor.setModelMarkers(
      model,
      'aidm',
      errors.map((e) => ({
        startLineNumber: e.line,
        endLineNumber: e.line,
        startColumn: 1,
        endColumn: model.getLineMaxColumn(Math.min(e.line, model.getLineCount())),
        message: e.message,
        severity: m.MarkerSeverity.Error,
      }))
    );
  }, [errors]);

  const apply = useCallback(
    async (value: string) => {
      setBusy(true);
      try {
        const res = await aiApi.editorApply(useModelStore.getState().project, value, targetDialect, authToken);
        setErrors(res.errors);
        if (res.ok) {
          setDirty(false);
          if (res.changes.length && res.project) {
            producedRef.current = res.project;
            setProject(res.project);
            setLastChanges(res.changes);
            refreshCompiledCode();
          }
        }
      } catch (e) {
        setErrors([{ line: 1, message: e instanceof Error ? e.message : String(e) }]);
      } finally {
        setBusy(false);
      }
    },
    [targetDialect, authToken, setProject, refreshCompiledCode]
  );

  const onChange = (v?: string) => {
    const value = v ?? '';
    setText(value);
    setDirty(true);
    if (timer.current) clearTimeout(timer.current);
    if (autoSync) timer.current = setTimeout(() => apply(value), 900);
  };

  const onMount: OnMount = (ed, monaco) => {
    editorRef.current = ed;
    monacoRef.current = monaco;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => apply(ed.getValue()));
  };

  return (
    <div className="h-full flex flex-col bg-slate-950 min-h-0" data-testid="model-editor">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-800 text-[11px] text-slate-400 shrink-0">
        <span className="font-semibold text-slate-200">Model Editor</span>
        <span className="px-1.5 rounded bg-slate-800 font-mono text-[10px] text-indigo-300">{targetDialect}</span>
        {busy ? (
          <span className="flex items-center gap-1 text-violet-300">
            <Loader2 className="w-3 h-3 animate-spin" /> syncing
          </span>
        ) : errors.length ? (
          <span className="flex items-center gap-1 text-rose-300">
            <AlertTriangle className="w-3 h-3" /> {errors.length} error(s) — line {errors[0].line}: {errors[0].message}
          </span>
        ) : dirty ? (
          <span className="text-amber-300">unsaved edits</span>
        ) : (
          <span className="flex items-center gap-1 text-emerald-300">
            <CheckCircle2 className="w-3 h-3" /> in sync
            {lastChanges.length > 0 && <span className="text-slate-500"> · last: {lastChanges.slice(0, 2).join('; ')}</span>}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <label className="flex items-center gap-1 cursor-pointer" title="Apply edits automatically while typing">
            <input type="checkbox" checked={autoSync} onChange={(e) => setAutoSync(e.target.checked)} />
            <Zap className="w-3 h-3 text-amber-300" /> Live sync
          </label>
          <button
            type="button"
            onClick={() => render()}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
          >
            <RotateCcw className="w-3 h-3" /> Revert
          </button>
          <button
            type="button"
            onClick={() => apply(text)}
            disabled={!dirty || busy}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white"
          >
            <Save className="w-3 h-3" /> Apply
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <Editor
          height="100%"
          language="sql"
          theme="vs-dark"
          value={text}
          onChange={onChange}
          onMount={onMount}
          options={{ minimap: { enabled: false }, fontSize: 12, wordWrap: 'off', scrollBeyondLastLine: false, tabSize: 2 }}
        />
      </div>
    </div>
  );
};
