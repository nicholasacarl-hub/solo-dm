import './testing/setup';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dm } from '@/dm';
import { useGame } from '@/state/gameStore';
import { useSettings } from '@/state/settingsStore';
import type { CampaignSettings } from '@/types';
import { PlayTable } from './PlayTable';
import { resetDmMock } from './testing/dmMock';
import { seedGame } from './testing/seed';
import { DESKTOP, setMatchMedia } from './testing/setup';

vi.mock('@/dm', () => import('./testing/dmMock'));
vi.mock('@/engine', () => import('./testing/engineMock'));
vi.mock('@/data', () => ({ useRulesIndex: () => null }));
vi.mock('@/ui/sheet/CharacterSheet', () => ({
  CharacterSheet: ({ variant, editable }: { variant: string; editable: boolean }) => (
    <p>
      Character sheet ({variant}
      {editable ? ', editable' : ''})
    </p>
  ),
}));
vi.mock('@/ui/sheet/ShortRestDialog', () => ({ ShortRestDialog: () => null }));
vi.mock('@/ui/sheet/LevelUpDialog', () => ({ LevelUpDialog: () => null }));
vi.mock('@/ui/shell/CampaignSettingsForm', () => ({
  CampaignSettingsForm: ({ value, onChange }: { value: CampaignSettings; onChange: (v: CampaignSettings) => void }) => (
    <button
      type="button"
      onClick={() => onChange({ ...value, difficulty: 'hard', veils: [...value.veils, 'Spiders'] })}
    >
      Make it harder
    </button>
  ),
}));

function renderTable() {
  const spies = seedGame();
  render(
    <MemoryRouter>
      <PlayTable />
    </MemoryRouter>,
  );
  return { spies, user: userEvent.setup() };
}

beforeEach(() => {
  resetDmMock();
  useSettings.setState({ mockMode: false });
});

describe('PlayTable — desktop', () => {
  beforeEach(() => setMatchMedia(DESKTOP));

  it('lays out scene and journal, the story, and the sheet with the combat tracker on top', () => {
    renderTable();
    const left = screen.getByRole('complementary', { name: 'Scene and journal' });
    const right = screen.getByRole('complementary', { name: 'Character' });
    expect(within(left).getByRole('heading', { name: 'Saltmarsh Docks' })).toBeInTheDocument();
    expect(within(left).getByRole('tablist', { name: 'Journal sections' })).toBeInTheDocument();
    expect(within(screen.getByRole('main')).getByRole('log', { name: 'Story so far' })).toBeInTheDocument();
    expect(within(right).getByRole('heading', { name: 'Ambush on the docks' })).toBeInTheDocument();
    expect(within(right).getByText('Character sheet (full, editable)')).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Table views' })).not.toBeInTheDocument();
  });

  it('shows the header: campaign, session, scene, usage and model', async () => {
    const { user } = renderTable();
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('heading', { name: 'The Drowned Lantern' })).toBeInTheDocument();
    expect(within(header).getByText('Session 2')).toBeInTheDocument();
    expect(within(header).getByText('Saltmarsh Docks · dusk · fog rolling in')).toBeInTheDocument();
    expect(within(header).getByRole('link', { name: 'Back to campaigns' })).toHaveAttribute('href', '/');
    expect(within(header).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');

    await user.click(within(header).getByRole('button', { name: /^Usage:/ }));
    const usage = screen.getByRole('dialog', { name: 'Usage' });
    expect(within(usage).getByRole('meter', { name: 'Context' })).toHaveAttribute(
      'aria-valuetext',
      '18k of 150k tokens',
    );
    expect(within(usage).getByText('Opus 5.5')).toBeInTheDocument();
    expect(
      within(usage).getByText(
        (_, el) => el?.tagName === 'P' && /\$0\.00 session.*\$0\.00 campaign/.test(el.textContent ?? ''),
      ),
    ).toBeInTheDocument();
  });

  it('shows a Demo badge in demo mode', () => {
    useSettings.setState({ mockMode: true });
    renderTable();
    expect(within(screen.getByRole('banner')).getByText('Demo')).toBeInTheDocument();
  });

  it('ends the session after confirming', async () => {
    const { user } = renderTable();
    await user.click(screen.getByRole('button', { name: 'End session' }));
    const dialog = screen.getByRole('heading', { name: 'End session 2?' }).closest('dialog')!;
    await user.click(within(dialog).getByRole('button', { name: 'End session' }));
    expect(dm.endSession).toHaveBeenCalledTimes(1);
  });

  it('saves table rules and tells the DM what changed', async () => {
    const { spies, user } = renderTable();
    await user.click(screen.getByRole('button', { name: 'Table rules' }));
    const dialog = screen.getByRole('heading', { name: 'Table rules' }).closest('dialog')!;
    const save = within(dialog).getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    await user.click(within(dialog).getByRole('button', { name: 'Make it harder' }));
    await user.click(save);
    await waitFor(() => expect(spies.updateCampaign).toHaveBeenCalledTimes(1));
    expect(useGame.getState().campaign?.settings.difficulty).toBe('hard');
    expect(spies.queueDmNotice).toHaveBeenCalledWith(
      'The player changed the table rules: difficulty: standard → hard; new veils (keep off-screen): "Spiders". Follow the new rules from now on.',
    );
  });

  it('toggles "Reveal all DM rolls"', async () => {
    const { user } = renderTable();
    const toggle = screen.getByRole('button', { name: 'Reveal all DM rolls' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Bandit stealth (secret)')).toBeInTheDocument();
  });

  it('offers to start the next session between sessions', async () => {
    const { user } = renderTable();
    act(() => useGame.setState({ activeSession: null }));
    expect(screen.queryByRole('textbox', { name: 'What do you do?' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start session 3' }));
    expect(dm.beginOrResume).toHaveBeenCalledTimes(1);
  });
});

describe('PlayTable — mobile', () => {
  it('shows the story with a bottom tab bar; Combat has an attention dot', async () => {
    const { user } = renderTable();
    const tabs = screen.getByRole('tablist', { name: 'Table views' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Story', 'Sheet', 'Combat(combat in progress)', 'Journal', 'Rules']);
    expect(screen.getByRole('textbox', { name: 'What do you do?' })).toBeVisible();

    await user.click(within(tabs).getByRole('tab', { name: /Sheet/ }));
    expect(screen.getByText('Character sheet (full, editable)')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { hidden: true, name: 'What do you do?' })).not.toBeVisible();

    await user.click(within(tabs).getByRole('tab', { name: /Combat/ }));
    expect(screen.getByRole('heading', { name: 'Ambush on the docks' })).toBeInTheDocument();

    await user.click(within(tabs).getByRole('tab', { name: /Journal/ }));
    expect(screen.getByRole('heading', { name: 'Saltmarsh Docks' })).toBeInTheDocument();

    await user.click(within(tabs).getByRole('tab', { name: /Rules/ }));
    expect(screen.getByText('Loading the rules…')).toBeInTheDocument();
  });

  it('keeps the session controls in the header menu', async () => {
    const { user } = renderTable();
    await user.click(screen.getByRole('button', { name: 'Table menu' }));
    const menu = screen.getByRole('dialog', { name: 'Table menu' });
    expect(within(menu).getByRole('meter', { name: 'Context' })).toBeInTheDocument();
    expect(within(menu).getByRole('switch', { name: 'Reveal all DM rolls' })).toBeInTheDocument();
    await user.click(within(menu).getByRole('button', { name: 'End session' }));
    expect(screen.getByRole('heading', { name: 'End session 2?' })).toBeInTheDocument();
  });

  it('marks new story while another tab is open', async () => {
    const { spies, user } = renderTable();
    const tabs = screen.getByRole('tablist', { name: 'Table views' });
    await user.click(within(tabs).getByRole('tab', { name: /Journal/ }));
    await act(async () => {
      await spies.appendLog({ kind: 'dm', text: 'A gull screams.' });
    });
    expect(within(tabs).getByRole('tab', { name: /Story/ })).toHaveTextContent('(new)');
  });
});
