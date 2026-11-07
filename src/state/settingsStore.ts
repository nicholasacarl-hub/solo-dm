/**
 * App settings, stored only in this browser (localStorage). The API key can instead be kept
 * in sessionStorage ("remember" off) so it disappears when the tab closes.
 *
 * Several tabs share the stored settings: each change is written over what is stored now (only the
 * changed fields), and changes saved by another tab are picked up as they happen ('storage'
 * events), so a tab opened earlier never wipes a key or token saved since.
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

/** The settings saved in this browser ({} when none or unreadable), or null without localStorage. */
function readStored(): Partial<PersistedSettings> | null {
  const local = safeStorage('local');
  if (!local) return null;
  try {
    const raw = local.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<PersistedSettings>) : {};
  } catch {
    return {};
  }
}

/**
 * Settings from what is stored. A remembered key is shared by every tab (localStorage); otherwise
 * the key is this tab's own (`ownKey`, from sessionStorage).
 */
function fromStored(stored: Partial<PersistedSettings>, ownKey: string): AppSettings {
  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...stored,
    githubSync: { ...DEFAULT_SETTINGS.githubSync, ...(stored.githubSync ?? {}) },
    apiKey: '',
  };
  merged.apiKey = merged.rememberApiKey ? (stored.apiKey ?? '') : ownKey;
  return merged;
}

function loadSettings(): AppSettings {
  return fromStored(readStored() ?? {}, safeStorage('session')?.getItem(SESSION_KEY_STORAGE) ?? '');
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
  const current = (): AppSettings => {
    const { update: _u, updateGithubSync: _g, setApiKey: _s, clearApiKey: _c, reset: _r, ...settings } = get();
    return settings;
  };
  /** Apply a change on top of what is stored now (another tab may have saved since), then save. */
  const commit = (change: (base: AppSettings) => Partial<AppSettings>) => {
    const memory = current();
    const stored = readStored();
    const base = stored ? fromStored(stored, memory.apiKey) : memory;
    const next: AppSettings = { ...base, ...change(base) };
    persist(next);
    set(next);
  };
  return {
    ...loadSettings(),
    update(patch) {
      commit(() => patch);
    },
    updateGithubSync(patch) {
      commit((base) => ({ githubSync: { ...base.githubSync, ...patch } }));
    },
    setApiKey(apiKey, remember) {
      commit((base) => ({ apiKey: apiKey.trim(), rememberApiKey: remember ?? base.rememberApiKey }));
    },
    clearApiKey() {
      commit(() => ({ apiKey: '' }));
    },
    reset() {
      commit(() => ({ ...DEFAULT_SETTINGS }));
    },
  };
});

/** Pick up settings another tab saved (the browser tells every other tab with a 'storage' event). */
function syncFromOtherTabs(event: StorageEvent): void {
  if (event.key !== null && event.key !== STORAGE_KEY) return;
  const stored = readStored();
  if (!stored) return;
  useSettings.setState(fromStored(stored, useSettings.getState().apiKey));
}

if (typeof window !== 'undefined') window.addEventListener('storage', syncFromOtherTabs);

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
