import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSettings } from '@/state/settingsStore';
import { sampleCampaign } from '@/test/fixtures';
import { autoCleanup, installDialogPolyfill, renderRoute } from '@/ui/shell/testUtils';
import { SettingsScreen } from './SettingsScreen';

vi.mock('@/dm', () => ({ testApiKey: vi.fn() }));
vi.mock('@/images', () => ({ testOpenAiKey: vi.fn() }));
vi.mock('@/state/gameStore', () => ({ useGame: { getState: () => ({ campaignId: null }) } }));
vi.mock('@/storage', () => ({
  testGithubConnection: vi.fn(),
  syncWithGithub: vi.fn(),
  listRemoteSaves: vi.fn(),
  pushCampaignToGithub: vi.fn(),
  pullCampaignFromGithub: vi.fn(),
  requestPersistentStorage: vi.fn(),
  useCampaignList: vi.fn(() => []),
  useImageStats: vi.fn(() => ({ count: 0, bytes: 0, byCampaign: {} })),
}));

const { testApiKey } = await import('@/dm');
const { testOpenAiKey } = await import('@/images');
const { testGithubConnection, syncWithGithub, requestPersistentStorage, useImageStats, useCampaignList } = await import('@/storage');

/** jsdom has no StorageManager; stand one in with the browser's answer to persisted(). */
function stubStorageManager(persisted: () => boolean) {
  Object.defineProperty(window.navigator, 'storage', {
    configurable: true,
    value: { persisted: vi.fn(async () => persisted()), persist: vi.fn(async () => persisted()) },
  });
}

autoCleanup();

function renderSettings() {
  return renderRoute(<SettingsScreen />, { path: '/settings' });
}

describe('SettingsScreen', () => {
  beforeEach(() => {
    installDialogPolyfill();
    localStorage.clear();
    sessionStorage.clear();
    useSettings.getState().reset();
    vi.mocked(testApiKey).mockReset();
    vi.mocked(testOpenAiKey).mockReset();
    vi.mocked(testGithubConnection).mockReset();
    vi.mocked(syncWithGithub).mockReset();
    vi.mocked(requestPersistentStorage).mockReset().mockResolvedValue(false);
    vi.mocked(useCampaignList).mockReset().mockReturnValue([]);
    vi.mocked(useImageStats).mockReset().mockReturnValue({ count: 0, bytes: 0, byCampaign: {} });
  });

  afterEach(() => {
    Reflect.deleteProperty(window.navigator, 'storage');
  });

  it('saves the key as you type and reports a successful test', async () => {
    vi.mocked(testApiKey).mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderSettings();

    const test = screen.getByRole('button', { name: 'Test' });
    expect(test).toBeDisabled();

    await user.type(screen.getByLabelText('Anthropic API key'), 'sk-ant-test-123');
    expect(useSettings.getState().apiKey).toBe('sk-ant-test-123');

    await user.click(test);
    expect(testApiKey).toHaveBeenCalledWith('sk-ant-test-123');
    expect(await screen.findByText('Your key works. You’re ready to play.')).toBeInTheDocument();
  });

  it('offers to turn off the demo DM once a key works', async () => {
    vi.mocked(testApiKey).mockResolvedValue({ ok: true });
    useSettings.getState().update({ mockMode: true });
    const user = userEvent.setup();
    renderSettings();

    await user.type(screen.getByLabelText('Anthropic API key'), 'sk-ant-test-123');
    await user.click(screen.getByRole('button', { name: 'Test' }));
    await user.click(await screen.findByRole('button', { name: 'Turn off the demo and play with Claude' }));
    expect(useSettings.getState().mockMode).toBe(false);
    expect(screen.queryByRole('button', { name: 'Turn off the demo and play with Claude' })).not.toBeInTheDocument();
  });

  it('shows the error when Anthropic rejects the key', async () => {
    vi.mocked(testApiKey).mockResolvedValue({ ok: false, error: 'That API key was rejected (401).' });
    const user = userEvent.setup();
    renderSettings();

    await user.type(screen.getByLabelText('Anthropic API key'), 'sk-ant-bad');
    await user.click(screen.getByRole('button', { name: 'Test' }));

    expect(await screen.findByText('That API key was rejected (401).')).toBeInTheDocument();
  });

  it('clears a stale result when the key changes', async () => {
    vi.mocked(testApiKey).mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderSettings();
    const input = screen.getByLabelText('Anthropic API key');
    await user.type(input, 'sk-ant-one');
    await user.click(screen.getByRole('button', { name: 'Test' }));
    await screen.findByText('Your key works. You’re ready to play.');

    await user.type(input, 'x');
    expect(screen.queryByText('Your key works. You’re ready to play.')).not.toBeInTheDocument();
  });

  it('hides the key until asked and can forget it when the tab closes', async () => {
    const user = userEvent.setup();
    renderSettings();
    const input = screen.getByLabelText('Anthropic API key');
    expect(input).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Show key' }));
    expect(input).toHaveAttribute('type', 'text');

    await user.type(input, 'sk-ant-secret');
    await user.click(screen.getByRole('switch', { name: 'Remember on this device' }));
    expect(useSettings.getState().rememberApiKey).toBe(false);
    expect(localStorage.getItem('solo-dm:settings')).not.toContain('sk-ant-secret');
    expect(sessionStorage.getItem('solo-dm:api-key')).toBe('sk-ant-secret');
  });

  it('updates DM settings', async () => {
    const user = userEvent.setup();
    renderSettings();
    const dmSection = within(screen.getByRole('region', { name: 'Your DM' }));
    await user.click(dmSection.getByRole('radio', { name: /Claude Sonnet 5\.5/ }));
    await user.click(dmSection.getByRole('radio', { name: /^High/ }));
    await user.click(dmSection.getByRole('radio', { name: /Reasoning summaries/ }));

    const s = useSettings.getState();
    expect(s.model).toBe('claude-sonnet-5-5');
    expect(s.effort).toBe('high');
    expect(s.thinkingDisplay).toBe('summarized');
    expect(screen.getByText(/Reasoning summaries can spoil secrets/)).toBeInTheDocument();
  });

  it('refuses public GitHub repositories', async () => {
    vi.mocked(testGithubConnection).mockResolvedValue({ ok: false, private: false, error: 'public' });
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole('switch', { name: 'Sync saves to GitHub' }));
    await user.type(screen.getByLabelText('Fine-grained token'), 'github_pat_x');
    await user.type(screen.getByLabelText('Owner'), 'me');
    await user.type(screen.getByLabelText('Repository'), 'saves');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText(/me\/saves is public/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
  });

  it('accepts "owner/repo" in the repository field and shows a sync summary', async () => {
    vi.mocked(syncWithGithub).mockResolvedValue({ pushed: ['a'], pulled: [], skipped: ['b'], conflicts: [], errors: [] });
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole('switch', { name: 'Sync saves to GitHub' }));
    await user.type(screen.getByLabelText('Fine-grained token'), 'github_pat_x');
    await user.type(screen.getByLabelText('Repository'), 'https://github.com/me/solo-saves.git');
    await user.tab();
    expect(useSettings.getState().githubSync).toMatchObject({ owner: 'me', repo: 'solo-saves' });
    expect(screen.getByLabelText('Owner')).toHaveValue('me');

    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('1 uploaded · 0 downloaded · 1 already up to date')).toBeInTheDocument();
    await waitFor(() => expect(useSettings.getState().githubSync.lastSyncedAt).not.toBeNull());
  });

  it('shows whether saves may be cleared and can ask the browser to keep them', async () => {
    let persisted = false;
    stubStorageManager(() => persisted);
    vi.mocked(requestPersistentStorage).mockImplementation(async () => {
      persisted = true;
      return true;
    });
    const user = userEvent.setup();
    renderSettings();

    expect(await screen.findByText(/Storage: may be cleared by the browser/)).toBeInTheDocument();
    expect(screen.getByText(/export a save file from a campaign’s card/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ask the browser to keep them' }));

    expect(requestPersistentStorage).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Storage: persistent/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ask the browser to keep them' })).not.toBeInTheDocument();
  });

  it('takes a refusal calmly and points to backups', async () => {
    stubStorageManager(() => false);
    useSettings.getState().updateGithubSync({ lastSyncedAt: Date.now() - 2 * 86_400_000 });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: 'Ask the browser to keep them' }));
    expect(await screen.findByText(/The browser makes this call itself/)).toBeInTheDocument();
    expect(screen.getByText(/Storage: may be cleared by the browser/)).toBeInTheDocument();
    expect(screen.getByText(/Last synced to GitHub 2 days ago/)).toBeInTheDocument();
  });

  it('says so when the browser cannot report how it stores saves', async () => {
    renderSettings();
    expect(await screen.findByText('This browser doesn’t say whether it will keep your saves.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ask the browser to keep them' })).not.toBeInTheDocument();
  });

  describe('illustrations', () => {
    const section = () => within(screen.getByRole('region', { name: 'Illustrations' }));

    it('saves the OpenAI key as you type, tests it, and then suggests illustrating key moments', async () => {
      vi.mocked(testOpenAiKey).mockResolvedValue({ ok: true });
      const user = userEvent.setup();
      renderSettings();
      const test = section().getByRole('button', { name: 'Test OpenAI key' });
      expect(test).toBeDisabled();
      expect(useSettings.getState().images.frequency).toBe('request');

      await user.type(section().getByLabelText('OpenAI API key'), 'sk-proj-abc');
      expect(useSettings.getState().images.openaiApiKey).toBe('sk-proj-abc');
      // The Claude key is a separate field.
      expect(useSettings.getState().apiKey).toBe('');

      await user.click(test);
      expect(testOpenAiKey).toHaveBeenCalledWith('sk-proj-abc');
      expect(await section().findByText('Your OpenAI key works. The DM can paint pictures.')).toBeInTheDocument();
      await user.click(section().getByRole('button', { name: 'Illustrate key moments' }));
      expect(useSettings.getState().images.frequency).toBe('moments');
      expect(section().getByRole('radio', { name: /Key moments/ })).toBeChecked();
      expect(section().queryByRole('button', { name: 'Illustrate key moments' })).not.toBeInTheDocument();
    });

    it("shows OpenAI's answer when the key fails, and spots a Claude key pasted by mistake", async () => {
      vi.mocked(testOpenAiKey).mockResolvedValue({ ok: false, error: 'OpenAI rejected this key.' });
      const user = userEvent.setup();
      renderSettings();
      const input = section().getByLabelText('OpenAI API key');
      expect(input).toHaveAttribute('type', 'password');
      await user.click(section().getByRole('button', { name: 'Show OpenAI key' }));
      expect(input).toHaveAttribute('type', 'text');

      await user.type(input, 'sk-ant-oops');
      expect(section().getByText(/looks like your Claude \(Anthropic\) key/)).toBeInTheDocument();
      await user.click(section().getByRole('button', { name: 'Test OpenAI key' }));
      expect(await section().findByText('OpenAI rejected this key.')).toBeInTheDocument();

      await user.click(section().getByRole('button', { name: 'Remove OpenAI key from this browser' }));
      expect(useSettings.getState().images.openaiApiKey).toBe('');
      expect(input).toHaveValue('');
    });

    it('points to the OpenAI key page and explains billing and where the key lives', () => {
      renderSettings();
      // The play screen links here (Settings → Illustrations) with #settings-section-images.
      expect(document.getElementById('settings-section-images')).toBe(screen.getByRole('region', { name: 'Illustrations' }));
      expect(section().getByRole('link', { name: /Create a key on platform\.openai\.com/ })).toHaveAttribute(
        'href',
        'https://platform.openai.com/api-keys',
      );
      expect(section().getByText(/bills pictures separately/)).toBeInTheDocument();
      expect(section().getByText(/Your key stays in this browser/)).toBeInTheDocument();
      expect(section().getByText(/aren’t included in save files or GitHub cloud saves/)).toBeInTheDocument();
      expect(section().getByText('No pictures on this device yet.')).toBeInTheDocument();
    });

    it('keeps the OpenAI key for this tab only when "Remember on this device" is off', async () => {
      const user = userEvent.setup();
      renderSettings();
      await user.type(section().getByLabelText('OpenAI API key'), 'sk-proj-secret');
      await user.click(screen.getByRole('switch', { name: 'Remember on this device' }));
      expect(localStorage.getItem('solo-dm:settings')).not.toContain('sk-proj-secret');
      expect(sessionStorage.getItem('solo-dm:openai-key')).toBe('sk-proj-secret');
      expect(section().getByText(/kept only until you close this tab/)).toBeInTheDocument();
    });

    it('chooses when to paint, the model and the quality', async () => {
      const user = userEvent.setup();
      renderSettings();
      expect(section().getByText(/Add an OpenAI key above/)).toBeInTheDocument();
      await user.click(section().getByRole('radio', { name: /^Off/ }));
      expect(useSettings.getState().images.frequency).toBe('off');

      const model = section().getByLabelText('Image model');
      expect(model).toHaveValue('gpt-image-2.5-flare');
      expect(section().getByText('Fast everyday illustrations. Recommended.')).toBeInTheDocument();
      await user.selectOptions(model, 'gpt-image-1-mini');
      expect(useSettings.getState().images.model).toBe('gpt-image-1-mini');
      expect(section().getByText('Cheapest, simpler images.')).toBeInTheDocument();

      expect(section().getByRole('radio', { name: /^Medium/ })).toBeChecked();
      expect(section().getByText(/a few cents a picture at medium/)).toBeInTheDocument();
      await user.click(section().getByRole('radio', { name: /^High/ }));
      expect(useSettings.getState().images.quality).toBe('high');
    });

    it('keeps a model Solo DM no longer offers selectable, and counts the pictures on this device per campaign', () => {
      useSettings.getState().updateImages({ model: 'gpt-image-1' });
      vi.mocked(useImageStats).mockReturnValue({
        count: 3,
        bytes: 3 * 1024 * 1024,
        byCampaign: { a: { count: 1, bytes: 1024 * 1024 }, b: { count: 2, bytes: 2 * 1024 * 1024 } },
      });
      vi.mocked(useCampaignList).mockReturnValue([
        { campaign: sampleCampaign({ id: 'a', name: 'The Ashen Crown' }), character: null, level: 0 },
        { campaign: sampleCampaign({ id: 'b', name: 'The Drowned Lantern' }), character: null, level: 0 },
      ]);
      renderSettings();
      expect(section().getByLabelText('Image model')).toHaveValue('gpt-image-1');
      expect(section().getByRole('option', { name: 'gpt-image-1 (custom)' })).toBeInTheDocument();
      expect(section().getByText('On this device: 3 pictures in 2 campaigns, 3.0 MB.')).toBeInTheDocument();
      const rows = within(section().getByRole('list', { name: 'Pictures by campaign' })).getAllByRole('listitem');
      expect(rows.map((r) => r.textContent)).toEqual(['The Drowned Lantern: 2 pictures, 2.0 MB', 'The Ashen Crown: 1 picture, 1.0 MB']);
    });
  });

  it('only deletes everything after typing DELETE', async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole('button', { name: 'Delete everything' }));
    const confirm = screen.getAllByRole('button', { name: 'Delete everything' }).at(-1)!;
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Type DELETE to confirm'), 'delete');
    expect(confirm).toBeDisabled();
  });
});
