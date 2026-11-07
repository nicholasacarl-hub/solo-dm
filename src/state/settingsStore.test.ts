import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/types';

const KEY = 'solo-dm:settings';
const SESSION_KEY = 'solo-dm:api-key';

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
