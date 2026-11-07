import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGame } from '@/state/gameStore';
import { sampleCampaign, sampleCharacter } from '@/test/fixtures';
import { clearRolls, queueRolls } from '@/ui/builder/testing/fakeEngine';
import { installDialogPolyfill, resetFakeGame } from '@/ui/builder/testing/fakeGameStore';
import { CharacterSheet } from './CharacterSheet';
import { LevelUpDialog } from './LevelUpDialog';

vi.mock('@/engine', async () => (await import('@/ui/builder/testing/fakeEngine')).fakeEngine);
vi.mock('@/state/gameStore', async () => (await import('@/ui/builder/testing/fakeGameStore')).fakeGameStoreModule());
vi.mock('@/data', async () => {
  const { builderFixture, spellFixture } = await import('@/ui/builder/testing/builderFixture');
  const spells = spellFixture();
  return {
    loadBuilderData: async () => builderFixture(),
    useBuilderData: () => ({ data: builderFixture(), error: null, loading: false }),
    getRulesIndex: async () => ({
      get: (id: string) => spells.find((s) => s.id === id),
      findByName: (name: string) => spells.find((s) => s.name === name),
    }),
  };
});

function Harness({ editable = true, variant = 'full' as const }: { editable?: boolean; variant?: 'full' | 'compact' }) {
  const character = useGame((s) => s.character);
  return character ? <CharacterSheet character={character} editable={editable} variant={variant} /> : null;
}

const notices = () => vi.mocked(useGame.getState().queueDmNotice).mock.calls.map(([text]) => text);

beforeAll(() => installDialogPolyfill());
afterEach(cleanup);

beforeEach(() => {
  clearRolls();
  resetFakeGame({ campaign: sampleCampaign(), character: sampleCharacter() });
});

describe('CharacterSheet', () => {
  it('applies quick damage through updateCharacter and tells the DM', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText('Amount of damage or healing'), '5');
    await user.click(screen.getByRole('button', { name: 'Damage' }));
    expect(useGame.getState().updateCharacter).toHaveBeenCalledTimes(1);
    expect(useGame.getState().character?.hp.current).toBe(7);
    expect(notices()).toEqual(['Player changed HP 12 → 7 (5 damage)']);
    expect(screen.getByLabelText('7 of 17 hit points')).toBeInTheDocument();
  });

  it('heals, capped at the maximum', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText('Amount of damage or healing'), '9');
    await user.click(screen.getByRole('button', { name: 'Heal' }));
    expect(useGame.getState().character?.hp.current).toBe(17);
    expect(notices()).toEqual(['Player changed HP 12 → 17 (healed 9)']);
  });

  it('marks a spell slot as used from the Spells tab', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Spells/ }));
    await user.click(screen.getByRole('button', { name: '1st level slots 1 of 4: available — mark as used' }));
    expect(useGame.getState().character?.spellcasting?.slots[1]).toEqual({ max: 4, used: 2 });
    expect(notices()).toEqual(['Player marked a 1st-level slot as used (2/4 left)']);
  });

  it('toggles prepared spells and opens a spell entry', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Spells/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Prepared: Magic Missile' }));
    expect(notices()).toEqual(['Player unprepared Magic Missile']);
    await user.click(screen.getByRole('button', { name: 'Shield' }));
    expect(await screen.findByText(/an imperceptible barrier of magical force/i)).toBeInTheDocument();
  });

  it('spends Heroic Inspiration and sets exhaustion', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Inspiration' }));
    await user.click(screen.getByRole('button', { name: 'Set exhaustion to 2' }));
    expect(useGame.getState().character).toMatchObject({ heroicInspiration: false, exhaustion: 2 });
    expect(notices()).toEqual(['Player spent Heroic Inspiration', 'Player changed exhaustion 0 → 2']);
  });

  it('logs unprompted rolls without queueing a notice', async () => {
    const user = userEvent.setup();
    queueRolls(15);
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Roll Arcana check' }));
    const appendLog = vi.mocked(useGame.getState().appendLog);
    expect(appendLog).toHaveBeenCalledTimes(1);
    const entry = appendLog.mock.calls[0][0];
    expect(entry).toMatchObject({ kind: 'roll', actor: 'player', secret: false });
    expect(entry.kind === 'roll' && entry.purpose).toMatch(/\(unprompted\)$/);
    expect(entry.kind === 'roll' && entry.roll.total).toBe(15 + 5);
    expect(notices()).toEqual([]);
  });

  it('asks for the die face in physical-dice mode', async () => {
    const user = userEvent.setup();
    const campaign = sampleCampaign();
    resetFakeGame({ campaign: { ...campaign, settings: { ...campaign.settings, playerRollMode: 'physical' } }, character: sampleCharacter() });
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Roll Intelligence saving throw' }));
    await user.type(screen.getByLabelText('d20 result'), '11');
    await user.click(screen.getByRole('button', { name: 'Log roll' }));
    const entry = vi.mocked(useGame.getState().appendLog).mock.calls[0][0];
    expect(entry).toMatchObject({ kind: 'roll', manual: true });
    expect(entry.kind === 'roll' && entry.roll.total).toBe(11 + 5);
  });

  it('removes inventory items after confirming', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Inventory/ }));
    await user.click(screen.getByRole('button', { name: 'Remove Robe' }));
    await user.click(screen.getByRole('button', { name: 'Confirm removing Robe' }));
    expect(useGame.getState().character?.inventory.some((i) => i.name === 'Robe')).toBe(false);
    expect(notices()).toEqual(['Player removed Robe from their inventory']);
  });

  it('is read-only without editable', () => {
    render(<Harness editable={false} />);
    expect(screen.queryByRole('button', { name: 'Damage' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Roll / })).toBeNull();
    expect(screen.getByText('Mira Voss')).toBeInTheDocument();
  });

  it('renders the compact variant without tabs', () => {
    render(<Harness variant="compact" />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('list', { name: 'Ability scores' })).toBeInTheDocument();
  });
});

describe('LevelUpDialog', () => {
  it('levels the current class with average HP and tells the DM', async () => {
    const user = userEvent.setup();
    render(<LevelUpDialog open onClose={() => undefined} />);
    expect(screen.getByRole('radio', { name: /Wizard 3 → 4/ })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    // d6 average 4 + CON 13 (+1)
    expect(useGame.getState().character?.hp.max).toBe(17 + 5);
    expect(useGame.getState().character?.classes[0].level).toBe(4);
    expect(notices()[0]).toMatch(/^Player leveled up to Wizard 4 \(character level 4\): \+5 HP/);
    expect(await screen.findByText('Level 4!')).toBeInTheDocument();
  });

  it('shows multiclass prerequisites', async () => {
    const user = userEvent.setup();
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(screen.getByRole('radio', { name: /Fighter 1/ }));
    expect(screen.getByText(/Fighter needs Strength or Dexterity 13\+/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Level up' })).toBeEnabled();
    await user.click(screen.getByRole('radio', { name: /Cleric 1/ }));
    expect(screen.getByRole('button', { name: 'Level up' })).toBeDisabled();
    await user.click(screen.getByLabelText('My DM allows it anyway'));
    expect(screen.getByRole('button', { name: 'Level up' })).toBeEnabled();
  });
});
