/**
 * App settings, stored only in this browser (localStorage). The API keys (Anthropic, and OpenAI for
 * illustrations) can instead be kept in sessionStorage ("remember" off) so they disappear when the
 * tab closes. One switch, rememberApiKey, governs both keys.
 *
 * Several tabs share the stored settings: each change is written over what is stored now (only the
 * changed fields), and changes saved by another tab are picked up as they happen ('storage'
 * events), so a tab opened earlier never wipes a key or token saved since.
 */
import { create } from 'zustand';
import { DEFAULT_SETTINGS, type AppSettings, type ImageSettings } from '@/types';

const STORAGE_KEY = 'solo-dm:settings';
const SESSION_KEY_STORAGE = 'solo-dm:api-key';
const SESSION_OPENAI_KEY_STORAGE = 'solo-dm:openai-key';

type PersistedSettings = Omit<AppSettings, 'apiKey' | 'images'> & {
  apiKey?: string;
  /** openaiApiKey is left out unless the keys are remembered. */
  images?: Partial<ImageSettings>;
};

/** The keys this tab holds for itself (used when they aren't remembered in localStorage). */
interface OwnKeys {
  apiKey: string;
  openaiApiKey: string;
}

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
 * Settings from what is stored. Remembered keys are shared by every tab (localStorage); otherwise
 * the keys are this tab's own (`own`, from sessionStorage).
 */
function fromStored(stored: Partial<PersistedSettings>, own: OwnKeys): AppSettings {
  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...stored,
    githubSync: { ...DEFAULT_SETTINGS.githubSync, ...(stored.githubSync ?? {}) },
    images: { ...DEFAULT_SETTINGS.images, ...(stored.images ?? {}), openaiApiKey: '' },
    apiKey: '',
  };
  merged.apiKey = merged.rememberApiKey ? (stored.apiKey ?? '') : own.apiKey;
  merged.images.openaiApiKey = merged.rememberApiKey ? (stored.images?.openaiApiKey ?? '') : own.openaiApiKey;
  return merged;
}

function ownKeys(settings: Pick<AppSettings, 'apiKey' | 'images'>): OwnKeys {
  return { apiKey: settings.apiKey, openaiApiKey: settings.images.openaiApiKey };
}

function loadSettings(): AppSettings {
  const session = safeStorage('session');
  return fromStored(readStored() ?? {}, {
    apiKey: session?.getItem(SESSION_KEY_STORAGE) ?? '',
    openaiApiKey: session?.getItem(SESSION_OPENAI_KEY_STORAGE) ?? '',
  });
}

/** Keep a key in this tab's sessionStorage, or remove it there. */
function keepForTab(session: Storage | null, name: string, key: string | null): void {
  if (key) session?.setItem(name, key);
  else session?.removeItem(name);
}

function persist(settings: AppSettings): void {
  const local = safeStorage('local');
  const session = safeStorage('session');
  const { apiKey, images, ...rest } = settings;
  const { openaiApiKey, ...imageRest } = images;
  const remember = settings.rememberApiKey;
  const toStore: PersistedSettings = remember ? { ...rest, apiKey, images } : { ...rest, images: imageRest };
  try {
    local?.setItem(STORAGE_KEY, JSON.stringify(toStore));
    keepForTab(session, SESSION_KEY_STORAGE, remember ? null : apiKey);
    keepForTab(session, SESSION_OPENAI_KEY_STORAGE, remember ? null : openaiApiKey);
  } catch {
    // Storage full or blocked: settings still work for this tab.
  }
}

export interface SettingsStore extends AppSettings {
  update(patch: Partial<AppSettings>): void;
  updateGithubSync(patch: Partial<AppSettings['githubSync']>): void;
  /** Change some illustration settings (merged over what is stored now). */
  updateImages(patch: Partial<ImageSettings>): void;
  setApiKey(apiKey: string, remember?: boolean): void;
  clearApiKey(): void;
  /** The OpenAI key for illustrations (trimmed; '' removes it). Kept like the Anthropic key. */
  setOpenAiKey(apiKey: string): void;
  reset(): void;
}

/** The settings without the store's actions (list every action here). */
function settingsOnly(state: SettingsStore): AppSettings {
  const {
    update: _u,
    updateGithubSync: _g,
    updateImages: _i,
    setApiKey: _s,
    clearApiKey: _c,
    setOpenAiKey: _o,
    reset: _r,
    ...settings
  } = state;
  return settings;
}

export const useSettings = create<SettingsStore>()((set, get) => {
  /** Apply a change on top of what is stored now (another tab may have saved since), then save. */
  const commit = (change: (base: AppSettings) => Partial<AppSettings>) => {
    const memory = settingsOnly(get());
    const stored = readStored();
    const base = stored ? fromStored(stored, ownKeys(memory)) : memory;
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
    updateImages(patch) {
      commit((base) => ({ images: { ...base.images, ...patch } }));
    },
    setApiKey(apiKey, remember) {
      commit((base) => ({ apiKey: apiKey.trim(), rememberApiKey: remember ?? base.rememberApiKey }));
    },
    clearApiKey() {
      commit(() => ({ apiKey: '' }));
    },
    setOpenAiKey(apiKey) {
      commit((base) => ({ images: { ...base.images, openaiApiKey: apiKey.trim() } }));
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
  useSettings.setState(fromStored(stored, ownKeys(useSettings.getState())));
}

if (typeof window !== 'undefined') window.addEventListener('storage', syncFromOtherTabs);

/** Plain snapshot of settings (no actions), for non-React code such as the DM agent. */
export function getSettings(): AppSettings {
  return settingsOnly(useSettings.getState());
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
