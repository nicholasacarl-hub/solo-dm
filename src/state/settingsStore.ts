/**
 * App settings, stored only in this browser (localStorage). The API key can instead be kept
 * in sessionStorage ("remember" off) so it disappears when the tab closes.
 */
import { create } from 'zustand';
import { DEFAULT_SETTINGS, type AppSettings } from '@/types';

const STORAGE_KEY = 'solo-dm:settings';
const SESSION_KEY_STORAGE = 'solo-dm:api-key';

type PersistedSettings = Omit<AppSettings, 'apiKey'> & { apiKey?: string };

function safeStorage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function loadSettings(): AppSettings {
  const local = safeStorage('local');
  const session = safeStorage('session');
  let stored: Partial<PersistedSettings> = {};
  try {
    const raw = local?.getItem(STORAGE_KEY);
    if (raw) stored = JSON.parse(raw) as Partial<PersistedSettings>;
  } catch {
    stored = {};
  }
  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...stored,
    githubSync: { ...DEFAULT_SETTINGS.githubSync, ...(stored.githubSync ?? {}) },
    apiKey: '',
  };
  merged.apiKey = merged.rememberApiKey
    ? (stored.apiKey ?? '')
    : (session?.getItem(SESSION_KEY_STORAGE) ?? '');
  return merged;
}

function persist(settings: AppSettings): void {
  const local = safeStorage('local');
  const session = safeStorage('session');
  const { apiKey, ...rest } = settings;
  const toStore: PersistedSettings = settings.rememberApiKey ? { ...rest, apiKey } : rest;
  try {
    local?.setItem(STORAGE_KEY, JSON.stringify(toStore));
    if (settings.rememberApiKey) session?.removeItem(SESSION_KEY_STORAGE);
    else if (apiKey) session?.setItem(SESSION_KEY_STORAGE, apiKey);
    else session?.removeItem(SESSION_KEY_STORAGE);
  } catch {
    // Storage full or blocked: settings still work for this tab.
  }
}

export interface SettingsStore extends AppSettings {
  update(patch: Partial<AppSettings>): void;
  updateGithubSync(patch: Partial<AppSettings['githubSync']>): void;
  setApiKey(apiKey: string, remember?: boolean): void;
  clearApiKey(): void;
  reset(): void;
}

export const useSettings = create<SettingsStore>()((set, get) => {
  const commit = (next: AppSettings) => {
    persist(next);
    set(next);
  };
  const current = (): AppSettings => {
    const { update: _u, updateGithubSync: _g, setApiKey: _s, clearApiKey: _c, reset: _r, ...settings } = get();
    return settings;
  };
  return {
    ...loadSettings(),
    update(patch) {
      commit({ ...current(), ...patch });
    },
    updateGithubSync(patch) {
      const s = current();
      commit({ ...s, githubSync: { ...s.githubSync, ...patch } });
    },
    setApiKey(apiKey, remember) {
      const s = current();
      commit({ ...s, apiKey: apiKey.trim(), rememberApiKey: remember ?? s.rememberApiKey });
    },
    clearApiKey() {
      commit({ ...current(), apiKey: '' });
    },
    reset() {
      commit({ ...DEFAULT_SETTINGS });
    },
  };
});

/** Plain snapshot of settings (no actions), for non-React code such as the DM agent. */
export function getSettings(): AppSettings {
  const { update: _u, updateGithubSync: _g, setApiKey: _s, clearApiKey: _c, reset: _r, ...settings } =
    useSettings.getState();
  return settings;
}

/** Resolve 'system' to the OS preference and apply it to <html data-theme>. Returns the applied theme. */
export function applyTheme(theme: AppSettings['theme']): 'dark' | 'light' {
  const prefersDark =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const resolved = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolved;
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute('content', resolved === 'dark' ? '#0f1115' : '#f3ede1');
  }
  return resolved;
}
