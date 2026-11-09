/**
 * The level-up dialog with the player's books (spec §5.4, §8.3): the real engine, the merged builder data
 * of the invented Gloamwood fixture (SRD Cleric and Fighter + the book), a fake game store.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { levelUp } from '@/engine';
import { useGame } from '@/state/gameStore';
import { sampleCampaign, sampleCharacter } from '@/test/fixtures';
import { DUSK_DOMAIN_MERGE_ADAPTATIONS, EXPECTED_MERGED, GLOAMWOOD_TITLE, TEXT } from '@/test/structuredFixtures';
import type { BuilderData, Character, ClassLevel, ClassOption, CompendiumEntry } from '@/types';
import { installDialogPolyfill, resetFakeGame } from '@/ui/builder/testing/fakeGameStore';
import { autoCleanup } from '@/ui/shell/testUtils';
import { LevelUpDialog } from './LevelUpDialog';

const mocks = vi.hoisted(() => ({ data: null as BuilderData | null, spells: [] as CompendiumEntry[] }));

vi.mock('@/state/gameStore', async () => (await import('@/ui/builder/testing/fakeGameStore')).fakeGameStoreModule());
vi.mock('@/data', () => {
  const key = (s: string) => s.toLowerCase();
  const index = {
    get: (id: string) => mocks.spells.find((s) => s.id === id),
    findByName: (name: string) => mocks.spells.find((s) => key(s.name) === key(name)),
  };
  return {
    useBuilderData: () => ({ data: mocks.data, error: null, loading: false }),
    loadBuilderData: async () => mocks.data,
    useRulesIndex: () => index,
    getRulesIndex: async () => index,
    countUnreviewedOptions: async () => [],
  };
});

const spell = (id: string, name: string, level: number): CompendiumEntry => ({
  id,
  sourceId: id.startsWith('lib:') ? 'gloam' : 'srd-5.2.1',
  sourceName: id.startsWith('lib:') ? GLOAMWOOD_TITLE : 'SRD 5.2.1',
  kind: 'spell',
  name,
  text: '',
  data: { level },
});

const classOf = (id: string): ClassOption => EXPECTED_MERGED.classes.find((c) => c.id === id) as ClassOption;
const FIGHTER = classOf('srd:class:fighter');
const CLERIC = classOf('srd:class:cleric');
const EMBER = FIGHTER.subclasses.find((s) => s.name === 'Ember Warden')!;

function hero(cl: Partial<ClassLevel> & Pick<ClassLevel, 'classId' | 'name' | 'level' | 'hitDie'>, extra: Partial<Character> = {}): Character {
  return {
    ...sampleCharacter(),
    classes: [{ casterType: 'none', ...cl }],
    hitDice: [{ die: cl.hitDie, total: cl.level, spent: 0 }],
    hp: { max: 30, current: 30, temp: 0 },
    features: [],
    spellcasting: undefined,
    inventory: [],
    armorClass: 12,
    acFormula: '10 + DEX',
    abilityScores: { str: 16, dex: 14, con: 13, int: 10, wis: 12, cha: 8 },
    ...extra,
  };
}
const fighter = (level: number, extra: Partial<ClassLevel> = {}) => hero({ classId: FIGHTER.id, name: 'Fighter', level, hitDie: 10, ...extra });
const notices = () => vi.mocked(useGame.getState().queueDmNotice).mock.calls.map(([text]) => text);
const sheet = () => useGame.getState().character as Character;

beforeAll(() => installDialogPolyfill());
autoCleanup();
beforeEach(() => {
  mocks.data = EXPECTED_MERGED;
  mocks.spells = [spell('srd:spell:faerie-fire', 'Faerie Fire', 1), spell('srd:spell:sleep', 'Sleep', 1), spell('lib:gloam:40', 'Ashen Choir', 2)];
  resetFakeGame({ campaign: sampleCampaign(), character: fighter(2) });
});

describe('LevelUpDialog with imported options', () => {
  it('offers an imported subclass with its book badge and adds its features with refs', async () => {
    const user = userEvent.setup();
    render(<LevelUpDialog open onClose={() => undefined} />);
    const group = screen.getByRole('radiogroup', { name: 'Subclass' });
    const ember = within(group).getByRole('radio', { name: /Ember Warden/ });
    expect(within(ember).getByText(`From ${GLOAMWOOD_TITLE}`)).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: /Champion/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Level up' })).toBeDisabled();

    await user.click(ember);
    expect(screen.getByText('From choosing Ember Warden: Ember Ward, Kindled Strikes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Level up' }));

    const c = sheet();
    expect(c.classes[0]).toMatchObject({ level: 3, subclass: 'Ember Warden', subclassId: EMBER.id, subclassRef: { entryId: EMBER.id, textCopied: false } });
    const ward = c.features.find((f) => f.name === 'Ember Ward');
    expect(ward).toMatchObject({ source: 'subclass', sourceName: 'Ember Warden 3', description: TEXT.emberWard.join('\n\n'), uses: { max: 2, recharge: 'long' } });
    expect(ward?.ref).toMatchObject({ entryId: EMBER.id, part: 'Ember Ward', level: 3, textCopied: true });
    expect(c.features.find((f) => f.name === 'Kindled Strikes')?.ref?.textCopied).toBe(true);
    // Names only reach the DM.
    expect(notices()[0]).toContain('subclass Ember Warden; new features: Fighter Subclass, Ember Ward, Kindled Strikes');
    expect(notices()[0]).not.toContain('ember answers');
  });

  it('catches up the subclass features of earlier levels when the subclass is chosen late', async () => {
    const user = userEvent.setup();
    resetFakeGame({ campaign: sampleCampaign(), character: fighter(3) });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(within(screen.getByRole('radiogroup', { name: 'Subclass' })).getByRole('radio', { name: /Ember Warden/ }));
    expect(screen.getByText(/caught up from earlier levels: Ember Ward \(level 3\), Kindled Strikes \(level 3\)/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(sheet().features.map((f) => f.name)).toEqual(expect.arrayContaining(['Ability Score Improvement', 'Ember Ward', 'Kindled Strikes']));
  });

  it("brings an older subclass's early features and its always-prepared spells", async () => {
    const user = userEvent.setup();
    resetFakeGame({
      campaign: sampleCampaign(),
      character: hero({ classId: CLERIC.id, name: 'Cleric', level: 2, hitDie: 8, casterType: 'full', spellcastingAbility: 'wis' }, { abilityScores: { str: 10, dex: 12, con: 14, int: 10, wis: 16, cha: 13 } }),
    });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(within(screen.getByRole('radiogroup', { name: 'Subclass' })).getByRole('radio', { name: /Dusk Domain/ }));
    expect(screen.getByText('From choosing Dusk Domain: Hearthlight Blessing, Channel Divinity: Settling Gloom')).toBeInTheDocument();
    expect(screen.getByText('Older edition: you choose Dusk Domain at Cleric level 3 here; features it gives earlier arrive then.', { selector: 'li' })).toBeInTheDocument();
    expect(screen.getByText('Always prepared from Dusk Domain: Faerie Fire, Sleep, Ashen Choir')).toBeInTheDocument();
    expect(screen.getByText(/Not in your rules yet: Darkness/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    const spells = sheet().spellcasting?.spells ?? [];
    expect(spells.map((s) => [s.id, s.name, s.alwaysPrepared])).toEqual([
      ['srd:spell:faerie-fire', 'Faerie Fire', true],
      ['srd:spell:sleep', 'Sleep', true],
      ['lib:gloam:40', 'Ashen Choir', true],
    ]);
    expect(spells[2].ref).toMatchObject({ entryId: 'lib:gloam:40', textCopied: false });
    expect(notices()[0]).toContain('always prepared: Faerie Fire, Sleep, Ashen Choir');
  });

  it("B6: an older subclass chosen at level 3 adds its older-edition notes to the character, once, and a feat's notes too", async () => {
    const user = userEvent.setup();
    const cleric = hero({ classId: CLERIC.id, name: 'Cleric', level: 2, hitDie: 8, casterType: 'full', spellcastingAbility: 'wis' }, { adaptationNotes: ['An earlier note.'] });
    resetFakeGame({ campaign: sampleCampaign(), character: cleric });
    const { unmount } = render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(within(screen.getByRole('radiogroup', { name: 'Subclass' })).getByRole('radio', { name: /Dusk Domain/ }));
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(sheet().adaptationNotes).toEqual(['An earlier note.', ...DUSK_DOMAIN_MERGE_ADAPTATIONS.map((a) => a.note)]);
    unmount();

    // Cleric 4 takes an older book's feat (no category printed): its note joins, nothing is added twice.
    const vigil = EXPECTED_MERGED.feats.find((f) => f.name === 'Watchlight Vigil')!;
    const general = { code: 'feat-general' as const, note: 'No feat category is printed, so Watchlight Vigil is treated as a General feat.' };
    mocks.data = { ...EXPECTED_MERGED, feats: EXPECTED_MERGED.feats.map((f) => (f === vigil ? { ...f, minLevel: undefined, prerequisite: undefined, source: { ...f.source!, adaptations: [general] } } : f)) };
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(screen.getByRole('radio', { name: 'Watchlight Vigil' }));
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(sheet().adaptationNotes).toEqual(['An earlier note.', ...DUSK_DOMAIN_MERGE_ADAPTATIONS.map((a) => a.note), general.note]);
  });

  it('preselects "Decide with my DM" and leaves the level-up and its notice exactly as before', async () => {
    const user = userEvent.setup();
    const start = fighter(3, { subclass: 'Champion', subclassId: 'srd:subclass:champion' });
    resetFakeGame({ campaign: sampleCampaign(), character: start });
    render(<LevelUpDialog open onClose={() => undefined} />);
    expect(screen.getByRole('radio', { name: 'Decide with my DM' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Lantern Bearer' })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Level up' }));

    // Today's notice: the engine's own reminders, untouched.
    const expected = levelUp(start, { className: 'Fighter', classId: FIGHTER.id, hpMethod: 'average', newFeatures: [{ name: 'Ability Score Improvement', source: 'class', description: '' }] });
    expect(notices()).toEqual([
      `Player leveled up to Fighter 4 (character level 4): +${expected.hpGained} HP (max ${expected.character.hp.max}); new features: Ability Score Improvement; still to choose: ${expected.reminders.join(' ')}`,
    ]);
    expect(sheet().features.map((f) => [f.name, f.source])).toEqual([['Ability Score Improvement', 'class']]);
    expect(sheet().abilityScores).toEqual(start.abilityScores);
  });

  it('applies Lantern Bearer: +1 to the chosen ability and the feat with its book text and ref', async () => {
    const user = userEvent.setup();
    resetFakeGame({ campaign: sampleCampaign(), character: fighter(3, { subclass: 'Champion', subclassId: 'srd:subclass:champion' }) });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(screen.getByRole('radio', { name: 'Lantern Bearer' }));
    await user.selectOptions(screen.getByLabelText('Ability Lantern Bearer raises'), 'cha');
    await user.click(screen.getByRole('button', { name: 'Level up' }));

    const c = sheet();
    expect(c.abilityScores.cha).toBe(9);
    expect(c.features.some((f) => f.name === 'Ability Score Improvement')).toBe(false);
    const feat = c.features.find((f) => f.name === 'Lantern Bearer');
    expect(feat).toMatchObject({ source: 'feat', sourceName: 'Ability Score Improvement (Fighter 4)', description: TEXT.lanternBearer.join('\n\n') });
    expect(feat?.ref).toMatchObject({ kind: 'feat', entryName: 'Lantern Bearer', textCopied: true });
    expect(notices()[0]).toContain('feat: Lantern Bearer (The Gloamwood Almanac)');
    expect(notices()[0]).not.toMatch(/Ability Score Improvement — raise/);
    expect(await screen.findByText('You took Lantern Bearer (+1 Charisma).')).toBeInTheDocument();
  });

  it('applies +2 to one ability and names it on the sheet', async () => {
    const user = userEvent.setup();
    resetFakeGame({ campaign: sampleCampaign(), character: fighter(3, { subclass: 'Champion', subclassId: 'srd:subclass:champion' }) });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(screen.getByRole('radio', { name: '+2 to one ability' }));
    await user.selectOptions(screen.getByLabelText('Ability to raise by 2'), 'str');
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(sheet().abilityScores.str).toBe(18);
    expect(sheet().features.map((f) => f.name)).toEqual(['Ability Score Improvement (+2 Strength)']);
    expect(notices()[0]).toContain('chose: +2 Strength');
  });

  it('B3: never offers a score already at 20 for an Ability Score Improvement, and flags a 19 for +2', async () => {
    const user = userEvent.setup();
    const start = fighter(3, { subclass: 'Champion', subclassId: 'srd:subclass:champion' });
    resetFakeGame({ campaign: sampleCampaign(), character: { ...start, abilityScores: { str: 20, dex: 19, con: 13, int: 10, wis: 12, cha: 8 } } });
    render(<LevelUpDialog open onClose={() => undefined} />);
    const plusTwo = screen.getByLabelText('Ability to raise by 2') as HTMLSelectElement;
    // The defaults can rise; Strength (20) can't be picked, Dexterity (19) gains only 1.
    expect(plusTwo.value).toBe('con');
    expect(within(plusTwo).getByRole('option', { name: 'Strength (20, the most)' })).toBeDisabled();
    expect(within(plusTwo).getByRole('option', { name: 'Dexterity (19, +1 only)' })).toBeEnabled();
    const first = screen.getByLabelText('First ability to raise by 1') as HTMLSelectElement;
    const second = screen.getByLabelText('Second ability to raise by 1') as HTMLSelectElement;
    expect([first.value, second.value]).toEqual(['dex', 'con']);
    expect(within(first).getByRole('option', { name: 'Strength (20, the most)' })).toBeDisabled();

    // +2 on the 19: the sheet, the summary and the DM notice say what took effect.
    await user.click(screen.getByRole('radio', { name: '+2 to one ability' }));
    await user.selectOptions(plusTwo, 'dex');
    expect(screen.getByText('Dexterity is 19: it can rise by 1 only.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(sheet().abilityScores.dex).toBe(20);
    expect(sheet().features.map((f) => f.name)).toEqual(['Ability Score Improvement (+1 Dexterity)']);
    expect(notices()[0]).toContain('chose: +1 Dexterity');
    expect(await screen.findByText('You raised Dexterity by 1.')).toBeInTheDocument();
  });

  it('flags a feat whose level is too low and asks for the DM’s say-so', async () => {
    const user = userEvent.setup();
    resetFakeGame({ campaign: sampleCampaign(), character: fighter(3, { subclass: 'Champion', subclassId: 'srd:subclass:champion' }) });
    render(<LevelUpDialog open onClose={() => undefined} />);
    expect(screen.getByText(/needs level 8/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Watchlight Vigil' }));
    expect(screen.getByRole('button', { name: 'Level up' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'My DM allows it' }));
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(sheet().features.map((f) => f.name)).toContain('Watchlight Vigil');
  });

  it('lists imported classes to multiclass into, and hides one named like a class the hero has', async () => {
    const user = userEvent.setup();
    const importedFighter: ClassOption = {
      ...FIGHTER,
      id: 'lib:gloam:class:fighter',
      subclasses: [],
      source: { sourceId: 'gloam', title: GLOAMWOOD_TITLE, recordId: 'rec:gloam:class:fighter', format: '2024', adaptations: [] },
    };
    mocks.data = { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, importedFighter] };
    resetFakeGame({ campaign: sampleCampaign(), character: fighter(3, { subclass: 'Champion', subclassId: 'srd:subclass:champion' }) });
    render(<LevelUpDialog open onClose={() => undefined} />);
    expect(screen.getByText(`Fighter (${GLOAMWOOD_TITLE}) isn't offered: your hero already has Fighter.`)).toBeInTheDocument();
    const select = screen.getByLabelText('Or multiclass into');
    expect(within(select).queryByText(/Fighter/)).toBeNull();
    await user.selectOptions(select, `Wickwright · ${GLOAMWOOD_TITLE} (d8)`);
    expect(screen.getByText(/Wickwright needs Intelligence 13\+/)).toBeInTheDocument();
    await user.click(screen.getByLabelText('My DM allows it anyway'));
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    const added = sheet().classes[1];
    expect(added).toMatchObject({ classId: 'lib:gloam:class:wickwright', name: 'Wickwright', level: 1, casterType: 'half', ref: { entryId: 'lib:gloam:class:wickwright', kind: 'class' } });
    expect(sheet().features.find((f) => f.name === 'Wick Sense')?.ref?.textCopied).toBe(true);
  });

  it("says when an imported class's data isn't on this device", () => {
    const ref = { sourceId: 'other', sourceTitle: GLOAMWOOD_TITLE, entryId: 'lib:other:class:lampwright', kind: 'class' as const, entryName: 'Lampwright', textHash: '', textCopied: false };
    resetFakeGame({ campaign: sampleCampaign(), character: hero({ classId: ref.entryId, name: 'Lampwright', level: 2, hitDie: 8, ref }) });
    render(<LevelUpDialog open onClose={() => undefined} />);
    expect(screen.getByText(`Class data for Lampwright comes from “${GLOAMWOOD_TITLE}”, which isn't on this device; your DM can fill in its features.`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Level up' })).toBeEnabled();
  });
});
