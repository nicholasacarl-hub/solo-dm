import './testing/setup';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dm } from '@/dm';
import { useGame, type GameStoreState } from '@/state/gameStore';
import { useSettings } from '@/state/settingsStore';
import { sampleMappedCombat } from '@/test/fixtures';
import type { CampaignSettings, CombatState } from '@/types';
import { PlayTable } from './PlayTable';
import { resetDmMock } from './testing/dmMock';
import { seedGame } from './testing/seed';
import { DESKTOP, setMatchMedia, stubBoundingRect } from './testing/setup';
import { usePlayView } from './playView';
import { resetMediaQueryCache } from './useMediaQuery';

vi.mock('@/dm', () => import('./testing/dmMock'));
vi.mock('@/engine', () => import('./testing/engineMock'));
vi.mock('@/images', () => import('./testing/imagesMock'));
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
    <>
      <button
        type="button"
        onClick={() => onChange({ ...value, difficulty: 'hard', veils: [...value.veils, 'Spiders'] })}
      >
        Make it harder
      </button>
      <button type="button" onClick={() => onChange({ ...value, transformations: 'consequences' })}>
        Let consequences stick
      </button>
    </>
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

  it('saves a transformations-only change without a notice of its own (the DM harness tells the DM)', async () => {
    const { spies, user } = renderTable();
    await user.click(screen.getByRole('button', { name: 'Table rules' }));
    const dialog = screen.getByRole('heading', { name: 'Table rules' }).closest('dialog')!;
    const save = within(dialog).getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    await user.click(within(dialog).getByRole('button', { name: 'Let consequences stick' }));
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(spies.updateCampaign).toHaveBeenCalledTimes(1));
    expect(useGame.getState().campaign?.settings.transformations).toBe('consequences');
    expect(spies.queueDmNotice).not.toHaveBeenCalled();
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

/** A matchMedia whose desktop breakpoint can be crossed mid-test (rotating an iPad, resizing). */
function liveBreakpoint(desktop: boolean): (next: boolean) => void {
  let isDesktop = desktop;
  const listeners = new Set<() => void>();
  resetMediaQueryCache();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() {
        return query.includes('min-width: 1024px') && isDesktop;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  return (next) => {
    isDesktop = next;
    act(() => listeners.forEach((listener) => listener()));
  };
}

describe('PlayTable — crossing the desktop breakpoint', () => {
  it('keeps the unsent draft and the OOC toggle when the layout switches', async () => {
    const setDesktop = liveBreakpoint(true);
    const { user } = renderTable();
    expect(screen.getByRole('complementary', { name: 'Character' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'OOC' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Out-of-character message to the DM' }),
      'Can I climb the lighthouse in the fog?',
    );

    setDesktop(false);
    expect(screen.queryByRole('complementary', { name: 'Character' })).not.toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Table views' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Out-of-character message to the DM' })).toHaveValue(
      'Can I climb the lighthouse in the fog?',
    );
    expect(screen.getByRole('button', { name: 'OOC' })).toHaveAttribute('aria-pressed', 'true');

    setDesktop(true);
    expect(screen.getByRole('textbox', { name: 'Out-of-character message to the DM' })).toHaveValue(
      'Can I climb the lighthouse in the fog?',
    );
  });
});

// ---------------------------------------------------------------------------
// The battle map's placements (spec §7.1, D58, D59)
// ---------------------------------------------------------------------------

function renderMapped(combat: CombatState = sampleMappedCombat({ heroTurn: true }), overrides: Partial<GameStoreState> = {}) {
  const spies = seedGame({ combat, ...overrides });
  render(
    <MemoryRouter>
      <PlayTable />
    </MemoryRouter>,
  );
  return { spies, user: userEvent.setup() };
}

const dockSection = () => screen.queryByRole('region', { name: 'Battle map' });

describe('PlayTable — the battle map on desktop (D59)', () => {
  beforeEach(() => {
    setMatchMedia(DESKTOP);
    stubBoundingRect(608, 336);
  });

  it('docks the map above the story only while a fight has a map; the composer stays', () => {
    renderTable();
    expect(dockSection()).not.toBeInTheDocument();
    act(() => useGame.setState({ combat: sampleMappedCombat({ heroTurn: true }) }));
    const dock = dockSection() as HTMLElement;
    expect(within(dock).getByRole('application', { name: 'Battle map: Dockside warehouse, 16 by 12 squares' })).toBeInTheDocument();
    expect(dock).toHaveClass('h-[clamp(16rem,42vh,30rem)]');
    const main = screen.getByRole('main');
    expect(main.firstElementChild).toBe(dock);
    expect(within(main).getByRole('textbox', { name: 'What do you do?' })).toBeInTheDocument();
  });

  it('collapses to the 44px bar and opens again', async () => {
    const { user } = renderMapped();
    await user.click(screen.getByRole('button', { name: 'Collapse the map' }));
    expect(dockSection()).not.toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(within(main).getByText('Ambush in the warehouse')).toBeInTheDocument();
    expect(within(main).getByText('· Your turn · 30 ft')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show map' }));
    expect(dockSection()).toBeInTheDocument();
  });

  it('keeps the dock size across the 1024px remount', async () => {
    const setDesktop = liveBreakpoint(true);
    const { user } = renderMapped();
    await user.click(screen.getByRole('button', { name: 'Larger map' }));
    expect(dockSection()).toHaveClass('h-[clamp(20rem,62vh,44rem)]');
    setDesktop(false);
    expect(dockSection()).not.toBeInTheDocument();
    setDesktop(true);
    expect(dockSection()).toHaveClass('h-[clamp(20rem,62vh,44rem)]');
  });

  it('leaks nothing about the hidden Cutthroat during its turn, anywhere on the table, until "Show DM secrets"', async () => {
    const { user } = renderMapped({ ...sampleMappedCombat(), turnIndex: 2 });
    const said = () => [document.body.textContent ?? '', ...[...document.body.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.value))].join('\n');
    expect(said()).not.toMatch(/Cutthroat/);
    expect(screen.getAllByText("Bandit 1's turn").length).toBeGreaterThan(0);
    await user.click(screen.getByRole('switch', { name: 'Show DM secrets (spoilers)' }));
    expect(said()).toMatch(/Cutthroat/);
    expect(screen.getByRole('application').querySelector('[data-token-id="c-5"]')).not.toBeNull();
  });
});

describe('PlayTable — the battle map on phones (D58)', () => {
  beforeEach(() => {
    setMatchMedia(() => false);
    stubBoundingRect(366, 366);
  });

  it('shows the BattleChip above the composer on Story; it opens the Combat tab with the map, the bar and the tracker', async () => {
    const { user } = renderMapped();
    const tabs = screen.getByRole('tablist', { name: 'Table views' });
    // The tab labels don't change; the Combat dot says it's your turn.
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Story', 'Sheet', 'Combat(your turn)', 'Journal', 'Rules']);
    await user.click(screen.getByRole('button', { name: 'Battle map · your turn · 30 ft' }));
    expect(usePlayView.getState().mobileTab).toBe('combat');
    const panel = screen.getByRole('tabpanel', { name: /Combat/ });
    expect(within(panel).getByRole('application', { name: /Battle map: Dockside warehouse/ })).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Ambush in the warehouse' })).toBeInTheDocument();
  });

  it('keeps the old Combat tab without a map', async () => {
    const { user } = renderTable();
    expect(screen.queryByRole('button', { name: /^Battle map/ })).not.toBeInTheDocument();
    await user.click(within(screen.getByRole('tablist', { name: 'Table views' })).getByRole('tab', { name: /Combat/ }));
    expect(screen.getByRole('heading', { name: 'Ambush on the docks' })).toBeInTheDocument();
    expect(screen.queryByRole('application')).not.toBeInTheDocument();
  });

  it('keeps the Combat dot on "your turn" while a hidden creature acts right after the hero (D42)', () => {
    const base = sampleMappedCombat({ heroTurn: true });
    const [mira, bandit1, cutthroat, ...rest] = base.combatants;
    renderMapped({ ...base, combatants: [mira, { ...cutthroat, initiative: 16 }, bandit1, ...rest], turnIndex: 1 });
    const tabs = screen.getByRole('tablist', { name: 'Table views' });
    expect(within(tabs).getByRole('tab', { name: /Combat/ })).toHaveTextContent('Combat(your turn)');
    expect(screen.getByRole('button', { name: 'Battle map · your turn · 30 ft' })).toBeInTheDocument();
  });

  it('drops a plan made on the Combat tab when the DM starts working, even with the map off screen (spec §7.3)', async () => {
    const { user } = renderMapped();
    await user.click(screen.getByRole('button', { name: 'Battle map · your turn · 30 ft' }));
    act(() => usePlayView.getState().setPlan({ to: { x: 3, y: 7 }, prefer: 'safest', dash: false, disengage: false, standUp: false }));
    await user.click(within(screen.getByRole('tablist', { name: 'Table views' })).getByRole('tab', { name: /Story/ }));
    expect(screen.queryByRole('application')).not.toBeInTheDocument();
    act(() => useGame.setState({ dm: { ...useGame.getState().dm, phase: 'thinking' } }));
    expect(usePlayView.getState().plan).toBeNull();
  });
});
