import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGame } from '@/state/gameStore';
import { sampleCampaign, sampleCharacter } from '@/test/fixtures';
import { builderFixture } from '@/ui/builder/testing/builderFixture';
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

  it('logs unprompted rolls and tells the DM the result', async () => {
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
    // The DM reads the transcript, not the log, so the roll reaches it as a notice.
    expect(notices()).toEqual(['The player rolled arcana check on their own: 20 (d20 (15) + 5 = 20).']);
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
    expect(notices()).toEqual(['The player rolled INT save on their own: 16 (d20 (11) + 5 = 16), on physical dice.']);
  });

  it('tells the DM about a death save once, through the death-save change', async () => {
    const user = userEvent.setup();
    queueRolls(12);
    resetFakeGame({ campaign: sampleCampaign(), character: sampleCharacter({ hp: { max: 17, current: 0, temp: 0 } }) });
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Roll death save' }));
    expect(vi.mocked(useGame.getState().appendLog)).toHaveBeenCalledTimes(1);
    expect(notices()).toEqual(['Player rolled a death saving throw: 12 — success (1 successes, 0 failures)']);
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

  it('never removes the last of an item with the minus button', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Inventory/ }));
    await user.click(screen.getByRole('button', { name: 'One fewer Dagger' }));
    expect(useGame.getState().character?.inventory.find((i) => i.name === 'Dagger')?.quantity).toBe(1);
    // At 1 the minus button is off; only Remove (with its confirmation) takes the item away.
    expect(screen.getByRole('button', { name: 'One fewer Dagger' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'One fewer Robe' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'One fewer Robe' }));
    expect(useGame.getState().character?.inventory.some((i) => i.name === 'Robe')).toBe(true);
    expect(notices()).toEqual(['Player changed Dagger quantity 2 → 1']);
  });

  it('lists the hero’s damage resistances with the proficiencies', () => {
    resetFakeGame({ campaign: sampleCampaign(), character: sampleCharacter({ damageResistances: ['poison'] }) });
    render(<Harness />);
    expect(screen.getByText('Damage resistances').nextSibling).toHaveTextContent('Poison');
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

  it('grows the uses of existing features from the class table and tells the DM', async () => {
    const user = userEvent.setup();
    const fighter = builderFixture().classes.find((c) => c.name === 'Fighter')!;
    const secondWind = fighter.features.find((f) => f.name === 'Second Wind')!;
    resetFakeGame({
      campaign: sampleCampaign(),
      character: sampleCharacter({
        classes: [{ classId: fighter.id, name: 'Fighter', level: 3, hitDie: 10, subclass: 'Champion', casterType: 'none' }],
        spellcasting: undefined,
        features: [
          // Built before uses had a scale: the refresh both grows it and attaches the table.
          { id: 'f-sw', name: 'Second Wind', source: 'class', sourceName: 'Fighter 1', description: secondWind.description, uses: { max: 2, used: 1, recharge: 'long' } },
        ],
      }),
    });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    // SRD 5.2.1 Fighter table: Second Wind 2 at levels 1-3, 3 at level 4.
    expect(useGame.getState().character?.features.find((f) => f.id === 'f-sw')?.uses).toEqual({
      max: 3,
      used: 1,
      recharge: 'long',
      scale: { by: 'table', className: 'Fighter', values: [2, 2, 2, 3] },
    });
    expect(notices()[0]).toContain('feature uses now: Second Wind 2 → 3');
    expect(await screen.findByText('Second Wind 2 → 3')).toBeInTheDocument();
  });

  it('shows multiclass prerequisites', async () => {
    const user = userEvent.setup();
    render(<LevelUpDialog open onClose={() => undefined} />);
    const multiclass = screen.getByLabelText('Or multiclass into');
    await user.selectOptions(multiclass, 'Fighter (d10)');
    expect(screen.getByText(/Fighter needs Strength or Dexterity 13\+/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Level up' })).toBeEnabled();
    await user.selectOptions(multiclass, 'Cleric (d8)');
    expect(screen.getByRole('button', { name: 'Level up' })).toBeDisabled();
    await user.click(screen.getByLabelText('My DM allows it anyway'));
    expect(screen.getByRole('button', { name: 'Level up' })).toBeEnabled();
  });
});
