import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePortrait } from '@/images';
import { useGame } from '@/state/gameStore';
import { importedPlaceholder } from '@/lib/importedContent';
import { sampleCampaign, sampleCharacter } from '@/test/fixtures';
import { GLOAMWOOD_TITLE, importedRef } from '@/test/structuredFixtures';
import type { Feature, Transformation } from '@/types';
import { builderFixture } from '@/ui/builder/testing/builderFixture';
import { clearRolls, queueRolls } from '@/ui/builder/testing/fakeEngine';
import { installDialogPolyfill, resetFakeGame } from '@/ui/builder/testing/fakeGameStore';
import { PAINTED_PORTRAIT, resetImagesMock, withImages } from '@/ui/play/testing/imagesMock';
import { CharacterSheet } from './CharacterSheet';
import { LevelUpDialog } from './LevelUpDialog';

vi.mock('@/engine', async () => (await import('@/ui/builder/testing/fakeEngine')).fakeEngine);
vi.mock('@/images', () => import('@/ui/play/testing/imagesMock'));
vi.mock('@/state/gameStore', async () => (await import('@/ui/builder/testing/fakeGameStore')).fakeGameStoreModule());
vi.mock('@/data', async () => {
  const { builderFixture, spellFixture } = await import('@/ui/builder/testing/builderFixture');
  const spells = spellFixture();
  const index = {
    get: (id: string) => spells.find((s) => s.id === id),
    findByName: (name: string) => spells.find((s) => s.name === name),
  };
  return {
    loadBuilderData: async () => builderFixture(),
    useBuilderData: () => ({ data: builderFixture(), error: null, loading: false }),
    getRulesIndex: async () => index,
    useRulesIndex: () => index,
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
  resetImagesMock();
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

  it("shows a spell's notes under its row and above its rules text, as the DM sees them", async () => {
    const user = userEvent.setup();
    const hero = sampleCharacter();
    const notes = 'Granted by the moth shrine: cast once at dusk without a slot.';
    const pulled = { notes: importedPlaceholder(GLOAMWOOD_TITLE), ref: { ...importedRef({ kind: 'spell', entryName: 'Sleep', part: undefined, level: undefined }), redacted: true as const } };
    const spells = hero.spellcasting!.spells.map((s) => (s.name === 'Shield' ? { ...s, notes: `  ${notes}\n` } : s.name === 'Sleep' ? { ...s, ...pulled } : s));
    resetFakeGame({ campaign: sampleCampaign(), character: { ...hero, spellcasting: { ...hero.spellcasting!, spells } } });
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Spells/ }));
    const row = screen.getByRole('button', { name: 'Shield' }).closest('li')!;
    expect(within(row).getByText(notes)).toBeInTheDocument();
    // A spell without notes gets no notes line.
    expect(screen.getByRole('button', { name: 'Magic Missile' }).closest('li')!.querySelectorAll('p')).toHaveLength(0);
    // Notes a save left out (they quoted a book) read plainly, not as the DM's placeholder sentence.
    expect(within(screen.getByRole('button', { name: 'Sleep' }).closest('li')!).getByText('Notes left out of this save (they quoted “The Gloamwood Almanac”).')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Shield' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(notes)).toBeInTheDocument();
    expect(within(dialog).getByText('Notes:')).toBeInTheDocument();
    expect(await within(dialog).findByText(/an imperceptible barrier of magical force/i)).toBeInTheDocument();
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

const curse = (overrides: Partial<Transformation> = {}): Transformation => ({
  id: 'tf-curse',
  name: 'Vampiric Curse',
  summary: 'The Drowned Lord’s bite is changing you: stronger by night, hungrier by day.',
  stage: 'Stage 1 of 3',
  origin: 'imposed',
  status: 'active',
  howItEnds: 'Greater Restoration before the third stage, or the Drowned Lord’s death.',
  featureIds: ['f-bite'],
  startedSession: 2,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const blessing: Transformation = {
  id: 'tf-blessing',
  name: 'Blessing of the Tide',
  summary: 'The sea goddess marked you for a season.',
  origin: 'accepted',
  status: 'ended',
  featureIds: [],
  startedSession: 1,
  endedSession: 2,
  createdAt: 1,
  updatedAt: 1,
};

const bite: Feature = {
  id: 'f-bite',
  name: 'Vampiric Bite',
  source: 'transformation',
  sourceName: 'Vampiric Curse',
  description: 'Bite a grappled creature: 1d6 piercing plus 1d6 necrotic, and you regain that much HP.',
  uses: { max: 1, used: 0, recharge: 'long' },
};

const leftover: Feature = { id: 'f-chill', name: 'Grave Chill', source: 'transformation', sourceName: 'An old curse', description: 'You feel no cold.' };

function transformed(transformations: Transformation[] = [curse(), blessing]) {
  const base = sampleCharacter();
  resetFakeGame({ campaign: sampleCampaign(), character: { ...base, features: [...base.features, bite, leftover], transformations } });
}

describe('CharacterSheet — transformations', () => {
  it('shows active transformations with stage, origin, what they mean and how they could end', async () => {
    const user = userEvent.setup();
    transformed();
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Features/ }));

    const section = screen.getByRole('region', { name: 'Transformations' });
    const card = within(section).getByRole('article', { name: 'Transformation: Vampiric Curse' });
    expect(within(card).getByText('Stage 1 of 3')).toBeInTheDocument();
    expect(within(card).getByText('Imposed')).toBeInTheDocument();
    expect(within(card).getByText(/stronger by night, hungrier by day/)).toBeInTheDocument();
    expect(within(card).getByText('How it could end:').parentElement).toHaveTextContent(/Greater Restoration before the third stage/);
    // Its features sit with it, in the arcane style, and aren't listed twice.
    const features = within(card).getByRole('list', { name: 'Features from Vampiric Curse' });
    expect(within(features).getByText('Vampiric Bite').closest('li')).toHaveClass('border-arcane/40');
    expect(screen.getAllByText('Vampiric Bite')).toHaveLength(1);
    // A transformation feature without its record still shows, styled the same.
    const others = screen.getByRole('region', { name: 'Transformation features' });
    expect(within(others).getByText('Grave Chill').closest('li')).toHaveAttribute('data-source', 'transformation');
  });

  it('folds ended transformations away', async () => {
    const user = userEvent.setup();
    transformed();
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Features/ }));
    const ended = screen.getByText('Ended (1)');
    expect(screen.getByText('Blessing of the Tide')).not.toBeVisible();
    await user.click(ended);
    expect(screen.getByText('Blessing of the Tide')).toBeVisible();
    expect(screen.getByText('Accepted')).toBeVisible();
    expect(screen.getByText('Ended in session 2')).toBeVisible();
  });

  it('says so when every transformation has ended', async () => {
    const user = userEvent.setup();
    transformed([blessing]);
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Features/ }));
    expect(screen.getByText('No transformation is active right now.')).toBeInTheDocument();
  });

  it('spends a transformation feature like any other (the DM is told)', async () => {
    const user = userEvent.setup();
    transformed();
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Features/ }));
    await user.click(screen.getByRole('button', { name: 'Vampiric Bite uses 1 of 1: available — mark as used' }));
    expect(useGame.getState().character?.features.find((f) => f.id === 'f-bite')?.uses?.used).toBe(1);
    expect(notices()).toHaveLength(1);
  });

  it('names what the hero is becoming in the header, which opens the Features tab', async () => {
    const user = userEvent.setup();
    transformed();
    render(<Harness />);
    const note = screen.getByRole('button', { name: 'Transformed: Vampiric Curse (Stage 1 of 3)' });
    await user.click(note);
    expect(screen.getByRole('tab', { name: /Features/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('region', { name: 'Transformations' })).toBeInTheDocument();
  });

  it('has no transformations section for a hero who is as built', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByText(/Transformed:/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Features/ }));
    expect(screen.queryByRole('region', { name: 'Transformations' })).not.toBeInTheDocument();
  });
});

describe('CharacterSheet — paint portrait', () => {
  it('is only offered when illustrations are available', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Paint portrait' })).not.toBeInTheDocument();
    cleanup();
    withImages();
    render(<Harness editable={false} />);
    expect(screen.queryByRole('button', { name: 'Paint portrait' })).not.toBeInTheDocument();
  });

  it('paints a portrait from the sheet and uses it only when the player says so (no DM notice)', async () => {
    const user = userEvent.setup();
    withImages();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Paint portrait' }));
    const dialog = screen.getByRole('dialog', { name: 'Paint a portrait' });
    await user.click(within(dialog).getByRole('button', { name: 'Paint portrait' }));

    expect(generatePortrait).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'char-1', name: 'Mira Voss' }),
      expect.objectContaining({ id: 'camp-1' }),
      expect.any(AbortSignal),
    );
    expect(await within(dialog).findByRole('img', { name: 'New portrait of Mira Voss' })).toHaveAttribute('src', PAINTED_PORTRAIT);
    expect(useGame.getState().character?.portrait).toBe('🧝‍♀️');

    await user.click(within(dialog).getByRole('button', { name: 'Use this portrait' }));
    expect(useGame.getState().updateCharacter).toHaveBeenCalledTimes(1);
    expect(useGame.getState().character?.portrait).toBe(PAINTED_PORTRAIT);
    expect(notices()).toEqual([]);
    expect(screen.queryByRole('dialog', { name: 'Paint a portrait' })).not.toBeInTheDocument();
  });

  it('shows progress while painting, and Stop abandons it', async () => {
    const user = userEvent.setup();
    let signal: AbortSignal | undefined;
    vi.mocked(generatePortrait).mockImplementation(
      (_c, _campaign, s) =>
        new Promise((_resolve, reject) => {
          signal = s;
          s?.addEventListener('abort', () => reject(new DOMException('The portrait was cancelled.', 'AbortError')));
        }),
    );
    withImages();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Paint portrait' }));
    const dialog = screen.getByRole('dialog', { name: 'Paint a portrait' });
    await user.click(within(dialog).getByRole('button', { name: 'Paint portrait' }));
    expect(within(dialog).getByRole('status')).toHaveTextContent('Painting your portrait…');

    await user.click(within(dialog).getByRole('button', { name: 'Stop' }));
    expect(signal?.aborted).toBe(true);
    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Paint portrait' })).toBeEnabled();
  });

  it('says why a portrait could not be painted and can try again', async () => {
    const user = userEvent.setup();
    vi.mocked(generatePortrait).mockRejectedValueOnce(new Error('The image service declined this picture.'));
    withImages();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Paint portrait' }));
    const dialog = screen.getByRole('dialog', { name: 'Paint a portrait' });
    await user.click(within(dialog).getByRole('button', { name: 'Paint portrait' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The image service declined this picture.');

    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByRole('img', { name: 'New portrait of Mira Voss' })).toBeInTheDocument();
    expect(generatePortrait).toHaveBeenCalledTimes(2);
  });

  it('abandons the painting when the dialog closes', async () => {
    const user = userEvent.setup();
    let signal: AbortSignal | undefined;
    vi.mocked(generatePortrait).mockImplementation((_c, _campaign, s) => {
      signal = s;
      return new Promise(() => {});
    });
    withImages();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Paint portrait' }));
    const dialog = screen.getByRole('dialog', { name: 'Paint a portrait' });
    await user.click(within(dialog).getByRole('button', { name: 'Paint portrait' }));
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(signal?.aborted).toBe(true);
    expect(useGame.getState().updateCharacter).not.toHaveBeenCalled();
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
