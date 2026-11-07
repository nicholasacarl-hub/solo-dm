import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/types';

const KEY = 'solo-dm:settings';
const SESSION_KEY = 'solo-dm:api-key';
const SESSION_OPENAI_KEY = 'solo-dm:openai-key';

/** A fresh copy of the store, as a tab opened now would load it. */
async function openTab() {
  vi.resetModules();
  return (await import('./settingsStore')).useSettings;
}

const stored = () => JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;

/** Save settings the way another tab would, returning the new stored text. */
function saveFromAnotherTab(patch: Record<string, unknown>): string {
  const text = JSON.stringify({ ...stored(), ...patch });
  localStorage.setItem(KEY, text);
  return text;
}

function storageEvent(newValue: string | null, key: string | null = KEY): void {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('settings shared by several tabs', () => {
  it("a tab opened earlier doesn't wipe the API key or GitHub token saved since", async () => {
    const stale = await openTab();
    expect(stale.getState().apiKey).toBe('');
    const other = await openTab();
    other.getState().setApiKey(' sk-ant-123 ', true);
    other.getState().updateGithubSync({ token: 'ghp_abc', owner: 'mira', repo: 'saves' });

    stale.getState().update({ theme: 'light' });

    expect(stored()).toMatchObject({ apiKey: 'sk-ant-123', theme: 'light', githubSync: { token: 'ghp_abc', owner: 'mira', repo: 'saves' } });
    expect(stale.getState()).toMatchObject({ apiKey: 'sk-ant-123', theme: 'light' });
    stale.getState().updateGithubSync({ path: 'campaigns' });
    expect(stored().githubSync).toMatchObject({ token: 'ghp_abc', owner: 'mira', path: 'campaigns' });
  });

  it('picks up settings another tab saved as soon as the browser reports them', async () => {
    const tab = await openTab();
    storageEvent(saveFromAnotherTab({ ...DEFAULT_SETTINGS, apiKey: 'sk-ant-456', model: 'claude-sonnet-5-5', mockMode: true }));
    expect(tab.getState()).toMatchObject({ apiKey: 'sk-ant-456', model: 'claude-sonnet-5-5', mockMode: true });

    // Another tab removed the key: this one forgets it too.
    storageEvent(saveFromAnotherTab({ apiKey: '' }));
    expect(tab.getState().apiKey).toBe('');

    // Other keys are ignored; clear() (key null) re-reads.
    localStorage.setItem(KEY, JSON.stringify({ theme: 'dark' }));
    storageEvent('x', 'something-else');
    expect(tab.getState().theme).toBe('system');
    storageEvent(null, null);
    expect(tab.getState().theme).toBe('dark');
  });

  it('a key kept for this tab only (remember off) stays out of localStorage and survives other tabs’ changes', async () => {
    const tab = await openTab();
    tab.getState().setApiKey('sk-ant-789', false);
    expect(stored().apiKey).toBeUndefined();
    expect(sessionStorage.getItem(SESSION_KEY)).toBe('sk-ant-789');

    storageEvent(saveFromAnotherTab({ theme: 'dark' }));
    expect(tab.getState()).toMatchObject({ apiKey: 'sk-ant-789', theme: 'dark' });
    tab.getState().update({ textSize: 'lg' });
    expect(tab.getState()).toMatchObject({ apiKey: 'sk-ant-789', textSize: 'lg', theme: 'dark' });

    tab.getState().clearApiKey();
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect(tab.getState().apiKey).toBe('');
  });

  it('reset still clears everything, the key included', async () => {
    const tab = await openTab();
    tab.getState().setApiKey('sk-ant-1', true);
    tab.getState().update({ theme: 'light' });
    tab.getState().reset();
    expect(stored()).toMatchObject({ theme: DEFAULT_SETTINGS.theme, apiKey: '' });
    expect(tab.getState().apiKey).toBe('');
  });
});

describe('the OpenAI key for illustrations', () => {
  it('follows the same "remember on this device" switch as the Anthropic key', async () => {
    const tab = await openTab();
    tab.getState().setOpenAiKey('  sk-proj-abc  ');
    expect(tab.getState().images.openaiApiKey).toBe('sk-proj-abc');
    // Remembered (the default): shared through localStorage.
    expect((stored().images as Record<string, unknown>).openaiApiKey).toBe('sk-proj-abc');
    expect(sessionStorage.getItem(SESSION_OPENAI_KEY)).toBeNull();

    // Remember off: both keys leave localStorage and live in this tab's sessionStorage.
    tab.getState().setApiKey('sk-ant-1');
    tab.getState().update({ rememberApiKey: false });
    expect(stored().apiKey).toBeUndefined();
    expect(stored().images).not.toHaveProperty('openaiApiKey');
    expect(JSON.stringify(stored())).not.toContain('sk-proj-abc');
    expect(sessionStorage.getItem(SESSION_OPENAI_KEY)).toBe('sk-proj-abc');
    expect(sessionStorage.getItem(SESSION_KEY)).toBe('sk-ant-1');

    // A reload of this tab still has it; a fresh tab (empty sessionStorage) doesn't.
    expect((await openTab()).getState().images.openaiApiKey).toBe('sk-proj-abc');
    sessionStorage.clear();
    expect((await openTab()).getState().images.openaiApiKey).toBe('');
  });

  it('keeps other image settings stored either way, and removes the key with an empty value', async () => {
    const tab = await openTab();
    tab.getState().update({ rememberApiKey: false });
    tab.getState().setOpenAiKey('sk-proj-xyz');
    tab.getState().updateImages({ frequency: 'moments', quality: 'high' });
    expect(stored().images).toEqual({ model: 'gpt-image-2.5-flare', quality: 'high', frequency: 'moments' });
    expect(tab.getState().images).toMatchObject({ openaiApiKey: 'sk-proj-xyz', frequency: 'moments', quality: 'high' });

    tab.getState().setOpenAiKey('');
    expect(sessionStorage.getItem(SESSION_OPENAI_KEY)).toBeNull();
    expect(tab.getState().images.openaiApiKey).toBe('');
  });

  it("merges other tabs' changes without losing this tab's own key", async () => {
    const tab = await openTab();
    tab.getState().update({ rememberApiKey: false });
    tab.getState().setOpenAiKey('sk-proj-mine');

    // Another tab changes the image model and the theme.
    storageEvent(saveFromAnotherTab({ theme: 'dark', images: { ...(stored().images as object), model: 'gpt-image-1-mini' } }));
    expect(tab.getState().theme).toBe('dark');
    expect(tab.getState().images).toMatchObject({ model: 'gpt-image-1-mini', openaiApiKey: 'sk-proj-mine' });

    // This tab's next change is written over what is stored now: the other tab's model survives.
    tab.getState().updateImages({ quality: 'low' });
    expect(stored().images).toMatchObject({ model: 'gpt-image-1-mini', quality: 'low' });
    expect(tab.getState().images.openaiApiKey).toBe('sk-proj-mine');
  });

  it('a tab opened earlier does not wipe a remembered OpenAI key saved since', async () => {
    const stale = await openTab();
    const other = await openTab();
    other.getState().setOpenAiKey('sk-proj-shared');
    stale.getState().updateImages({ frequency: 'off' });
    expect(stored().images).toMatchObject({ openaiApiKey: 'sk-proj-shared', frequency: 'off' });
    expect(stale.getState().images.openaiApiKey).toBe('sk-proj-shared');
  });

  it('fills image settings missing from older saves, and reset clears the key', async () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: 'light' }));
    const tab = await openTab();
    expect(tab.getState().images).toEqual(DEFAULT_SETTINGS.images);
    tab.getState().setOpenAiKey('sk-proj-1');
    tab.getState().reset();
    expect(tab.getState().images).toEqual(DEFAULT_SETTINGS.images);
    expect(DEFAULT_SETTINGS.images.openaiApiKey).toBe('');
  });

  it('getSettings is a plain snapshot without the store actions', async () => {
    vi.resetModules();
    const { getSettings } = await import('./settingsStore');
    const snapshot = getSettings();
    expect(Object.values(snapshot).some((v) => typeof v === 'function')).toBe(false);
    expect(snapshot.images).toEqual(DEFAULT_SETTINGS.images);
  });
});
