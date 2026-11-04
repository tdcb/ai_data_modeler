import React, { useState, useEffect } from 'react';
import {
  Key,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Trash2,
  ExternalLink,
  Shield,
  Sparkles,
  X,
} from 'lucide-react';
import { useModelStore } from '../../store/useModelStore';
import { api } from '../../services/api';

interface ApiKeySettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', badge: 'Recommended · Ultra Fast' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', badge: 'Deep Reasoning' },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', badge: 'Fast Multimodal' },
  { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', badge: 'High Speed' },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', badge: '2M Context' },
];

export const ApiKeySettingsModal: React.FC<ApiKeySettingsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const currentUser = useModelStore((s) => s.currentUser);
  const authToken = useModelStore((s) => s.authToken);
  const setStatusBanner = useModelStore((s) => s.setStatusBanner);

  const userKeyStorageId = `metaforge_gemini_key_${currentUser.email}`;
  const userModelStorageId = `metaforge_gemini_model_${currentUser.email}`;

  const [apiKey, setApiKey] = useState('');
  const [selectedModel, setSelectedModel] = useState('gemini-2.5-flash');
  const [showKey, setShowKey] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [hasServerKey, setHasServerKey] = useState(false);
  const [maskedKey, setMaskedKey] = useState<string | null>(null);

  // Load existing key from user account on modal open
  useEffect(() => {
    if (!isOpen) return;

    // Keys live only on the server; purge copies older versions kept in the browser.
    localStorage.removeItem(userKeyStorageId);
    localStorage.removeItem('metaforge_gemini_api_key');

    const cachedModel = localStorage.getItem(userModelStorageId);
    if (cachedModel) {
      setSelectedModel(cachedModel);
    }

    // Also fetch status from server for the authenticated user
    setIsLoading(true);
    api
      .getUserApiKeys(authToken)
      .then((res) => {
        setHasServerKey(res.has_gemini_key);
        setMaskedKey(res.masked_gemini_key || null);
        if (res.has_gemini_key) setApiKey('');
      })
      .catch((err) => {
        console.warn('Could not fetch user API key status:', err);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [isOpen, authToken, userKeyStorageId, userModelStorageId]);

  if (!isOpen) return null;

  const handleTestKey = async () => {
    const keyToTest = apiKey.trim();
    if (!keyToTest) {
      setTestResult({
        success: false,
        message: 'Please enter a Gemini API Key to test.',
      });
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${keyToTest}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: 'Respond with the single word: "READY"' }],
            },
          ],
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        let msg = `HTTP ${res.status}`;
        try {
          const json = JSON.parse(text);
          if (json.error?.message) msg = json.error.message;
        } catch {}
        setTestResult({
          success: false,
          message: `Connection failed: ${msg}`,
        });
        return;
      }

      setTestResult({
        success: true,
        message: `Successfully connected to Google Gemini (${selectedModel})! Your key is verified and operational.`,
      });
    } catch (err: any) {
      setTestResult({
        success: false,
        message: `Network test error: ${err.message || err}`,
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSaveKey = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed && !hasServerKey) {
      setStatusBanner({
        type: 'error',
        message: 'Please enter a valid Google Gemini API Key.',
      });
      return;
    }

    setIsSaving(true);
    try {
      if (trimmed) {
        // Save to user database record
        const res = await api.saveUserApiKeys(trimmed, authToken);
        localStorage.setItem(userModelStorageId, selectedModel);
        localStorage.setItem('metaforge_gemini_model', selectedModel);

        setHasServerKey(res.has_gemini_key);
        setMaskedKey(res.masked_gemini_key || null);
        setStatusBanner({
          type: 'success',
          message: `Saved Gemini API key for ${currentUser.email}.`,
        });
      } else {
        localStorage.setItem(userModelStorageId, selectedModel);
        localStorage.setItem('metaforge_gemini_model', selectedModel);
      }
      onClose();
    } catch (err: any) {
      setStatusBanner({
        type: 'error',
        message: `Error saving API key: ${err.message || err}`,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearKey = async () => {
    if (!confirm('Are you sure you want to remove your saved Gemini API key?')) {
      return;
    }
    setIsSaving(true);
    try {
      await api.deleteUserGeminiKey(authToken);
      localStorage.removeItem(userKeyStorageId);
      localStorage.removeItem('metaforge_gemini_api_key');
      setApiKey('');
      setHasServerKey(false);
      setMaskedKey(null);
      setTestResult(null);
      setStatusBanner({
        type: 'info',
        message: `Gemini API key cleared for ${currentUser.email}.`,
      });
    } catch (err: any) {
      setStatusBanner({
        type: 'error',
        message: `Failed to remove API key: ${err.message || err}`,
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/40">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-violet-600/20 border border-violet-500/30 flex items-center justify-center text-violet-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                User AI API Key Settings
              </h2>
              <div className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5">
                <span>Account:</span>
                <span className="font-mono text-sky-400 font-medium">
                  {currentUser.email}
                </span>
                <span className="text-slate-600">·</span>
                <span className="px-1.5 py-0.2 rounded bg-slate-800 text-[10px] text-slate-300">
                  {currentUser.role}
                </span>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 text-xs text-slate-300">
          {/* Privacy & Isolation Callout */}
          <div className="p-3 rounded-xl bg-violet-950/30 border border-violet-500/30 flex items-start gap-3">
            <Shield className="w-4 h-4 text-violet-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="font-semibold text-violet-200">
                Private &amp; User-Isolated Storage
              </div>
              <div className="text-[11px] text-slate-300 leading-relaxed">
                Your Google Gemini API Key is stored directly on your personal user account.
                It is <strong>strictly private to {currentUser.email}</strong> and will never be shared with, displayed to, or used by other workspace users or team members.
              </div>
            </div>
          </div>

          {/* Current Saved Key Status */}
          {hasServerKey && (
            <div className="flex items-center justify-between p-3 rounded-xl bg-slate-950/80 border border-emerald-500/30">
              <div className="flex items-center gap-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <div>
                  <div className="font-semibold text-emerald-300">
                    Active Gemini Key Configured
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                    Saved key preview: {maskedKey || '••••••••••••••••'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={handleClearKey}
                disabled={isSaving}
                title="Remove saved API key"
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-rose-400 hover:bg-rose-950/50 hover:text-rose-300 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Remove</span>
              </button>
            </div>
          )}

          {/* API Key Input */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="font-semibold text-slate-200 flex items-center gap-1.5">
                <Key className="w-3.5 h-3.5 text-sky-400" />
                <span>Google Gemini API Key</span>
              </label>
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-sky-400 hover:underline flex items-center gap-1"
              >
                <span>Get a free Gemini API key</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setTestResult(null);
                }}
                placeholder={
                  hasServerKey
                    ? 'Enter new key to overwrite existing saved key...'
                    : 'Paste your personal Gemini API key here...'
                }
                className="w-full bg-slate-950 border border-slate-700 focus:border-violet-500 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-500 font-mono pr-10 outline-none transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
              >
                {showKey ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            </div>
            <p className="text-[11px] text-slate-400">
              Used for AI-assisted schema generation, data profiling business definitions, autonomous refactoring, and data model view synthesis.
            </p>
          </div>

          {/* Model Selection */}
          <div className="space-y-2">
            <label className="font-semibold text-slate-200 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-violet-400" />
              <span>Preferred Gemini Model</span>
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {GEMINI_MODELS.map((m) => {
                const active = selectedModel === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      setSelectedModel(m.id);
                      setTestResult(null);
                    }}
                    className={`flex flex-col items-start p-2.5 rounded-xl border text-left transition-all ${
                      active
                        ? 'bg-violet-600/15 border-violet-500 text-white shadow-sm'
                        : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                    }`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className="font-semibold text-xs text-white">
                        {m.name}
                      </span>
                      {active && (
                        <CheckCircle2 className="w-3.5 h-3.5 text-violet-400" />
                      )}
                    </div>
                    <span className="text-[10px] text-violet-300 mt-0.5">
                      {m.badge}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Test Status Banner */}
          {testResult && (
            <div
              className={`p-3 rounded-xl border flex items-start gap-2.5 ${
                testResult.success
                  ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                  : 'bg-rose-950/40 border-rose-500/40 text-rose-300'
              }`}
            >
              {testResult.success ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <div className="text-[11px] leading-relaxed">
                {testResult.message}
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-slate-800 bg-slate-950/60 flex items-center justify-between">
          <button
            type="button"
            onClick={handleTestKey}
            disabled={isTesting || (!apiKey.trim() && !hasServerKey)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 disabled:opacity-40 transition-colors"
          >
            {isTesting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 text-sky-400" />
            )}
            <span>{isTesting ? 'Verifying...' : 'Test Connection'}</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSaveKey}
              disabled={isSaving || (!apiKey.trim() && !hasServerKey)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-600/20 disabled:opacity-40 transition-all"
            >
              {isSaving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5" />
              )}
              <span>{isSaving ? 'Saving...' : 'Save to My Account'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
