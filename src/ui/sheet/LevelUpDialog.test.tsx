/**
 * The level-up dialog with the player's books (spec §5.4, §8.3): the real engine, the merged builder data
 * of the invented Gloamwood fixture (SRD Cleric and Fighter + the book), a fake game store.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import compendiumRaw from '../../../public/srd/compendium.json?raw';
import { cantripsKnown, preparedSpellCount } from '@/data/options/classFeatures';
import { levelUp } from '@/engine';
import { useGame } from '@/state/gameStore';
import { sampleCampaign, sampleCharacter } from '@/test/fixtures';
import { DUSK_DOMAIN_MERGE_ADAPTATIONS, EXPECTED_MERGED, GLOAMWOOD_TITLE, SRD_BUILDER_DATA, TEXT, importedRef } from '@/test/structuredFixtures';
import type { BuilderData, Character, ClassLevel, ClassOption, CompendiumEntry, KnownSpell } from '@/types';
import { installDialogPolyfill, resetFakeGame } from '@/ui/builder/testing/fakeGameStore';
import { toast } from '@/ui/components/toast';
import { autoCleanup } from '@/ui/shell/testUtils';
import { LevelUpDialog } from './LevelUpDialog';

/**
 * `indexReady: false`: the rules index isn't built yet (useRulesIndex is null, useRulesIndexState loading) and
 * getRulesIndex builds it (once `indexGate` settles, when set), or fails with `indexFails`.
 */
const mocks = vi.hoisted(() => ({ data: null as BuilderData | null, spells: [] as CompendiumEntry[], indexReady: true, indexFails: false, indexGate: null as Promise<void> | null }));

vi.mock('@/state/gameStore', async () => (await import('@/ui/builder/testing/fakeGameStore')).fakeGameStoreModule());
vi.mock('@/data', () => {
  const key = (s: string) => s.toLowerCase();
  const index = {
    get: (id: string) => mocks.spells.find((s) => s.id === id),
    findByName: (name: string) => mocks.spells.find((s) => key(s.name) === key(name)),
    // The spell choices' lists (useSpellOptions).
    list: (q: { kind?: string }) => mocks.spells.filter((s) => !q.kind || s.kind === q.kind),
  };
  return {
    useBuilderData: () => ({ data: mocks.data, error: null, loading: false }),
    loadBuilderData: async () => mocks.data,
    useRulesIndex: () => (mocks.indexReady ? index : null),
    useRulesIndexState: () => (mocks.indexReady ? { index, loading: false, error: null } : { index: null, loading: true, error: null }),
    getRulesIndex: async () => {
      if (mocks.indexGate) await mocks.indexGate;
      if (mocks.indexFails) throw new Error('the rules index failed');
      return index;
    },
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
  mocks.indexReady = true;
  mocks.indexFails = false;
  mocks.indexGate = null;
  resetFakeGame({ campaign: sampleCampaign(), character: fighter(2) });
});
afterEach(() => {
  vi.restoreAllMocks();
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
    // Darkness isn't in the rules here: the DM can add it, under the subclass's name so no class counts it.
    expect(notices()[0]).toContain("always prepared: Faerie Fire, Sleep, Ashen Choir; not added (not in the rules here; add with the source named, not a class's name): Darkness (Dusk Domain)");
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

  it("offers a 2024 book's feat in place of the SRD's of its name, and keeps the one picked if the book arrives meanwhile", async () => {
    const user = userEvent.setup();
    const lantern = EXPECTED_MERGED.feats.find((f) => f.name === 'Lantern Bearer')!;
    const withBook = { ...EXPECTED_MERGED, feats: [...EXPECTED_MERGED.feats, { ...lantern, id: 'lib:gloam:feat:grappler', name: 'Grappler' }] };
    resetFakeGame({ campaign: sampleCampaign(), character: fighter(3, { subclass: 'Champion', subclassId: 'srd:subclass:champion' }) });
    mocks.data = withBook;
    const view = render(<LevelUpDialog open onClose={() => undefined} />);
    expect(screen.getAllByRole('radio', { name: /^Grappler/ })).toHaveLength(1);
    view.unmount();
    mocks.data = EXPECTED_MERGED;
    const again = render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(screen.getByRole('radio', { name: /^Grappler/ }));
    mocks.data = withBook;
    again.rerender(<LevelUpDialog open onClose={() => undefined} />);
    const grapplers = screen.getAllByRole('radio', { name: /^Grappler/ });
    expect(grapplers).toHaveLength(2);
    expect(grapplers[0]).toBeChecked();
  });

  it("counts Tough's Hit Points at the level it's taken in the feat panel (twice the character level)", async () => {
    const user = userEvent.setup();
    // An Origin feat in a 2024 book, as in the SRD's category list: offered at an Ability Score Improvement too.
    const tough = { id: 'lib:gloam:feat:tough', name: 'Tough', category: 'origin' as const, description: 'Invented: hardier than most.' };
    mocks.data = { ...EXPECTED_MERGED, feats: [...EXPECTED_MERGED.feats, tough] };
    resetFakeGame({ campaign: sampleCampaign(), character: fighter(3, { subclass: 'Champion', subclassId: 'srd:subclass:champion' }) });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(screen.getByRole('radio', { name: /^Tough/ }));
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    // d10 average 6 + CON 1, and Tough's 2 × level 4.
    expect(sheet().hp.max).toBe(30 + 7 + 8);
    expect(sheet().features.filter((f) => f.name === 'Tough')).toEqual([expect.objectContaining({ source: 'feat', sourceName: 'Ability Score Improvement (Fighter 4)', description: 'Invented: hardier than most.' })]);
    expect(notices()[0]).toContain('+15 HP');
    // Beside a book species' trait named Tough, which isn't the feat: the same.
    cleanup();
    const trait = { id: 't-tough', name: 'Tough', source: 'species' as const, sourceName: 'Stonefolk', description: 'Invented: a trait of the name.' };
    resetFakeGame({ campaign: sampleCampaign(), character: { ...fighter(3, { subclass: 'Champion', subclassId: 'srd:subclass:champion' }), features: [trait] } });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(screen.getByRole('radio', { name: /^Tough/ }));
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(sheet().hp.max).toBe(30 + 7 + 8);
    expect(sheet().features.filter((f) => f.name === 'Tough').map((f) => f.source)).toEqual(['species', 'feat']);
  });

  describe('every feat the hero qualifies for at an Ability Score Improvement (SRD 5.2.1 Fighter 4: "or another feat of your choice for which you qualify")', () => {
    const builderFighter = (extra: Partial<Character> = {}) => ({
      ...fighter(3, { subclass: 'Champion', subclassId: 'srd:subclass:champion' }),
      // As the builder makes a Fighter: its Fighting Style feature and the style it chose.
      features: [
        { id: 'f-style', name: 'Fighting Style', source: 'class' as const, sourceName: 'Fighter 1', description: '' },
        { id: 'f-defense', name: 'Defense', source: 'feat' as const, sourceName: 'Fighting Style (Fighter 1)', description: '' },
      ],
      initiativeBonusExtra: 0,
      ...extra,
    });
    const radios = (group: HTMLElement) => within(group).getAllByRole('radio').map((r) => r.getAttribute('aria-label'));

    it('lists them under a heading per category, a style the hero has greyed out and its prerequisite checked', () => {
      resetFakeGame({ campaign: sampleCampaign(), character: builderFighter() });
      render(<LevelUpDialog open onClose={() => undefined} />);
      expect(radios(screen.getByRole('group', { name: 'General feats' }))).toEqual(['Grappler', 'Lantern Bearer', 'Watchlight Vigil']);
      expect(radios(screen.getByRole('group', { name: 'Origin feats' }))).toEqual(['Alert', 'Magic Initiate', 'Savage Attacker', 'Skilled', "Moth's Grace"]);
      const styles = screen.getByRole('group', { name: 'Fighting Style feats' });
      expect(radios(styles)).toEqual(['Archery', 'Defense', 'Great Weapon Fighting', 'Two-Weapon Fighting', 'Hooked Reach']);
      expect(within(styles).getByRole('radio', { name: 'Defense' })).toBeDisabled();
      // The panel checked "Fighting Style Feature": no "(your DM checks)" for it.
      expect(within(styles).getAllByText('met')).toHaveLength(5);
      expect(within(styles).queryByText(/your DM checks/)).toBeNull();
      expect(screen.queryByRole('group', { name: 'Epic Boon feats' })).toBeNull();
    });

    it('takes Alert, which adds the Proficiency Bonus to Initiative (SRD 5.2.1 Alert: Initiative Proficiency)', async () => {
      const user = userEvent.setup();
      resetFakeGame({ campaign: sampleCampaign(), character: builderFighter() });
      render(<LevelUpDialog open onClose={() => undefined} />);
      await user.click(screen.getByRole('radio', { name: 'Alert' }));
      await user.click(screen.getByRole('button', { name: 'Level up' }));
      expect(sheet().initiativeBonusExtra).toBe(2);
      expect(sheet().features.filter((f) => f.name === 'Alert')).toEqual([expect.objectContaining({ source: 'feat', sourceName: 'Ability Score Improvement (Fighter 4)' })]);
      expect(sheet().features.some((f) => f.name === 'Ability Score Improvement')).toBe(false);
      expect(notices()[0]).toContain('feat: Alert');
      expect(notices()[0]).not.toMatch(/Ability Score Improvement — raise/);
    });

    it("takes Alert beside a transformation's power of its name, which isn't the feat: the feat's bonus all the same", async () => {
      const user = userEvent.setup();
      const power = { id: 't-alert', name: 'Alert', source: 'transformation' as const, sourceName: 'Owl-Touched', description: 'Invented: a power of the change.' };
      const start = builderFighter();
      resetFakeGame({ campaign: sampleCampaign(), character: { ...start, features: [...start.features, power] } });
      render(<LevelUpDialog open onClose={() => undefined} />);
      await user.click(screen.getByRole('radio', { name: 'Alert' }));
      await user.click(screen.getByRole('button', { name: 'Level up' }));
      expect(sheet().initiativeBonusExtra).toBe(2);
      expect(sheet().features.filter((f) => f.name === 'Alert').map((f) => f.source)).toEqual(['transformation', 'feat']);
    });

    it("takes Magic Initiate, and the player and the DM are reminded of the choices the sheet doesn't make", async () => {
      const user = userEvent.setup();
      resetFakeGame({ campaign: sampleCampaign(), character: builderFighter() });
      render(<LevelUpDialog open onClose={() => undefined} />);
      await user.click(screen.getByRole('radio', { name: 'Magic Initiate' }));
      await user.click(screen.getByRole('button', { name: 'Level up' }));
      const reminder = 'Magic Initiate: choose its spell list, two cantrips and a level 1 spell from it, and its spellcasting ability.';
      expect(notices()[0]).toContain(`still to choose: ${reminder}`);
      expect(await screen.findByText(reminder)).toBeInTheDocument();
    });

    it('lists the Epic Boons first at Epic Boon, then the other feats the hero qualifies for (SRD 5.2.1 Fighter 19)', () => {
      resetFakeGame({ campaign: sampleCampaign(), character: builderFighter({ classes: [{ classId: FIGHTER.id, name: 'Fighter', level: 18, hitDie: 10, casterType: 'none', subclass: 'Champion', subclassId: 'srd:subclass:champion' }], hitDice: [{ die: 10, total: 18, spent: 0 }] }) });
      render(<LevelUpDialog open onClose={() => undefined} />);
      const titles = screen.getAllByRole('group', { name: /feats$/ }).map((g) => document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent);
      expect(titles).toEqual(['Epic Boon feats', 'General feats', 'Origin feats', 'Fighting Style feats']);
      expect(radios(screen.getByRole('group', { name: 'Epic Boon feats' }))[0]).toBe('Boon of Combat Prowess');
    });

    it('offers no Fighting Style feats to a hero without the feature; a General feat that asks for one is for the DM to check', () => {
      // An invented book's General feat with the Fighting Style feature among its prerequisites: offered, flagged.
      const drill = { id: 'lib:gloam:feat:banner-drill', name: 'Banner Drill', category: 'general' as const, prerequisite: 'Level 4+, Fighting Style Feature', description: 'Invented.' };
      mocks.data = { ...EXPECTED_MERGED, feats: [...EXPECTED_MERGED.feats, drill] };
      resetFakeGame({ campaign: sampleCampaign(), character: builderFighter({ features: [] }) });
      render(<LevelUpDialog open onClose={() => undefined} />);
      expect(screen.getByRole('group', { name: 'Origin feats' })).toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Fighting Style feats' })).toBeNull();
      expect(screen.queryByRole('radio', { name: 'Archery' })).toBeNull();
      const row = screen.getByRole('radio', { name: 'Banner Drill' }).closest('li') as HTMLElement;
      expect(within(row).getByText('Fighting Style Feature (your DM checks)')).toBeInTheDocument();
    });
  });

  describe("the Champion's Additional Fighting Style (SRD 5.2.1 Champion, level 7)", () => {
    const champion = (extra: Partial<Character> = {}) => ({ ...fighter(6, { subclass: 'Champion', subclassId: 'srd:subclass:champion' }), ...extra });

    it('offers a Fighting Style, the one the hero has already taken greyed out, and adds it beside the feature', async () => {
      const user = userEvent.setup();
      const defense = { id: 'f-defense', name: 'Defense', source: 'feat' as const, sourceName: 'Fighting Style (Fighter 1)', description: '' };
      resetFakeGame({ campaign: sampleCampaign(), character: champion({ features: [defense] }) });
      render(<LevelUpDialog open onClose={() => undefined} />);
      expect(screen.getByRole('heading', { name: 'Additional Fighting Style' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /^Defense/ })).toBeDisabled();
      // One category: no headings, and no Origin or General feats.
      expect(screen.queryByRole('group', { name: /feats$/ })).toBeNull();
      expect(screen.queryByRole('radio', { name: 'Alert' })).toBeNull();
      await user.click(screen.getByRole('radio', { name: /^Archery/ }));
      await user.click(screen.getByRole('button', { name: 'Level up' }));
      expect(sheet().features.map((f) => [f.name, f.source, f.sourceName])).toEqual([
        ['Defense', 'feat', 'Fighting Style (Fighter 1)'],
        ['Additional Fighting Style', 'subclass', 'Champion 7'],
        ['Archery', 'feat', 'Additional Fighting Style (Fighter 7)'],
      ]);
      expect(notices()[0]).toContain('feat: Archery');
      // Nothing left to choose or add: the style is chosen and the subclass's feature is on the sheet.
      expect(notices()[0]).not.toMatch(/choose another Fighting Style|gain a feature from your subclass/);
    });

    it('leaves the choice to the DM by default, and the notice names it', async () => {
      const user = userEvent.setup();
      resetFakeGame({ campaign: sampleCampaign(), character: champion() });
      render(<LevelUpDialog open onClose={() => undefined} />);
      expect(screen.getByRole('radio', { name: 'Decide with my DM' })).toBeChecked();
      await user.click(screen.getByRole('button', { name: 'Level up' }));
      expect(sheet().features.map((f) => f.name)).toEqual(['Additional Fighting Style']);
      expect(notices()[0]).toContain('still to choose: Fighter 7: Additional Fighting Style — choose another Fighting Style.');
      expect(notices()[0]).not.toContain('gain a feature from your subclass');
    });
  });

  it("offers the styles a book subclass's own Fighting Style prints, and adds the one chosen as the subclass's with its ref", async () => {
    const user = userEvent.setup();
    // An invented book subclass of the SRD Fighter whose level-3 Fighting Style lists two styles of its own.
    const guard = 'While you hold your lantern aloft, the first attack against you each round has Disadvantage.';
    const lash = 'Your wick cracks like a whip, and a creature it hits drops one object it holds.';
    const style = {
      level: 3,
      name: 'Fighting Style',
      description: ['Choose one of the options below.', `***Lantern Guard.*** ${guard}`, `***Wick Lash.*** ${lash}`].join('\n\n'),
      ref: { ...EMBER.features[0].ref!, entryId: 'lib:gloam:subclass:lamp-sentinel', entryName: 'Lamp Sentinel', part: 'Fighting Style' },
    };
    const sentinel = { ...EMBER, id: 'lib:gloam:subclass:lamp-sentinel', name: 'Lamp Sentinel', features: [style] };
    mocks.data = { ...EXPECTED_MERGED, classes: EXPECTED_MERGED.classes.map((c) => (c.id === FIGHTER.id ? { ...c, subclasses: [...c.subclasses, sentinel] } : c)) };
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(within(screen.getByRole('radiogroup', { name: 'Subclass' })).getByRole('radio', { name: /Lamp Sentinel/ }));
    expect(screen.getByRole('radio', { name: /^Lantern Guard/ })).toBeEnabled();
    // One category, the styles printed and the feats alike: no headings.
    expect(screen.queryByRole('group', { name: /feats$/ })).toBeNull();
    await user.click(screen.getByRole('radio', { name: /^Wick Lash/ }));
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    const own = sheet().features.filter((f) => f.source === 'subclass');
    expect(own.map((f) => [f.name, f.sourceName])).toEqual([
      ['Fighting Style', 'Lamp Sentinel 3'],
      ['Wick Lash', 'Fighting Style (Lamp Sentinel 3)'],
    ]);
    expect(own[1]).toMatchObject({ description: lash, ref: { kind: 'subclass', entryId: sentinel.id, part: 'Wick Lash', textCopied: true } });
    expect(notices()[0]).toContain('Wick Lash');

    // Another subclass printing a style of that name: switching to it after the pick applies its words and ref, as shown.
    cleanup();
    resetFakeGame({ campaign: sampleCampaign(), character: fighter(2) });
    const coil = 'Your wick coils around a foe, and it has Disadvantage on its next attack roll.';
    const keeperStyle = {
      ...style,
      description: ['Choose one of the options below.', `***Wick Lash.*** ${coil}`, '***Ember Stance.*** Invented: another style.'].join('\n\n'),
      ref: { ...style.ref, entryId: 'lib:gloam:subclass:hearth-keeper', entryName: 'Hearth Keeper' },
    };
    const keeper = { ...EMBER, id: 'lib:gloam:subclass:hearth-keeper', name: 'Hearth Keeper', features: [keeperStyle] };
    mocks.data = { ...EXPECTED_MERGED, classes: EXPECTED_MERGED.classes.map((c) => (c.id === FIGHTER.id ? { ...c, subclasses: [...c.subclasses, sentinel, keeper] } : c)) };
    render(<LevelUpDialog open onClose={() => undefined} />);
    const subclasses = () => within(screen.getByRole('radiogroup', { name: 'Subclass' }));
    await user.click(subclasses().getByRole('radio', { name: /Lamp Sentinel/ }));
    await user.click(screen.getByRole('radio', { name: /^Wick Lash/ }));
    await user.click(subclasses().getByRole('radio', { name: /Hearth Keeper/ }));
    expect(screen.getByRole('radio', { name: /^Wick Lash/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(sheet().features.find((f) => f.name === 'Wick Lash')).toMatchObject({
      sourceName: 'Fighting Style (Hearth Keeper 3)',
      description: coil,
      ref: { entryId: keeper.id, entryName: 'Hearth Keeper', part: 'Wick Lash' },
    });

    // A Fighter 2 / Paladin 5 whose (invented) oath has a feature named Fighting Style too still gains the subclass's own.
    cleanup();
    const paladin: ClassLevel = { classId: 'srd:class:paladin', name: 'Paladin', level: 5, hitDie: 10, casterType: 'half', subclass: 'Oath of the Wick' };
    const oath = { id: 'f-oath', name: 'Fighting Style', source: 'subclass' as const, sourceName: 'Oath of the Wick 3', description: 'Invented: the oath’s own style.' };
    const two = fighter(2);
    resetFakeGame({ campaign: sampleCampaign(), character: { ...two, classes: [...two.classes, paladin], features: [oath] } });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(subclasses().getByRole('radio', { name: /Lamp Sentinel/ }));
    await user.click(screen.getByRole('radio', { name: /^Lantern Guard/ }));
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(sheet().features.filter((f) => f.source === 'subclass').map((f) => [f.name, f.sourceName])).toEqual([
      ['Fighting Style', 'Oath of the Wick 3'],
      ['Fighting Style', 'Lamp Sentinel 3'],
      ['Lantern Guard', 'Fighting Style (Lamp Sentinel 3)'],
    ]);
  });

  it('a Repeatable feat taken again is a second feature with its ref; the first stays as it was, its uses too', async () => {
    const user = userEvent.setup();
    const lantern = EXPECTED_MERGED.feats.find((f) => f.name === 'Lantern Bearer')!;
    mocks.data = { ...EXPECTED_MERGED, feats: EXPECTED_MERGED.feats.map((f) => (f === lantern ? { ...f, repeatable: true } : f)) };
    const had = {
      id: 'f-old',
      name: 'Lantern Bearer',
      source: 'feat' as const,
      sourceName: 'Ability Score Improvement (Fighter 4)',
      description: TEXT.lanternBearer.join('\n\n'),
      uses: { max: 2, used: 1, recharge: 'long' as const },
      ref: lantern.ref,
    };
    resetFakeGame({ campaign: sampleCampaign(), character: { ...fighter(7, { subclass: 'Champion', subclassId: 'srd:subclass:champion' }), features: [had] } });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(screen.getByRole('radio', { name: 'Lantern Bearer' }));
    await user.selectOptions(screen.getByLabelText('Ability Lantern Bearer raises'), 'cha');
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    const taken = sheet().features.filter((f) => f.name === 'Lantern Bearer');
    expect(taken).toEqual([
      had,
      expect.objectContaining({ source: 'feat', sourceName: 'Ability Score Improvement (Fighter 8)', ref: expect.objectContaining({ entryName: 'Lantern Bearer' }) }),
    ]);
    expect(taken[1].id).not.toBe('f-old');
    expect(sheet().abilityScores.cha).toBe(9);
  });

  it("names the uses the DM ruled in the DM notice, which the level-up kept (SRD 5.2.1 Fighter: Second Wind)", async () => {
    const user = userEvent.setup();
    // The DM's features_add gave Second Wind four uses (FeatureUses.ruled); the Fighter table would give 2 at Fighter 3.
    const wind = { id: 'f-wind', name: 'Second Wind', source: 'class' as const, sourceName: 'Fighter 1', description: 'DM ruling: four uses.', uses: { max: 4, used: 1, recharge: 'short' as const, ruled: true } };
    resetFakeGame({ campaign: sampleCampaign(), character: { ...fighter(2), features: [wind] } });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(screen.getByRole('radio', { name: /Champion/ }));
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(sheet().features.find((f) => f.id === 'f-wind')?.uses).toEqual(wind.uses);
    expect(notices()[0]).toContain('; kept your ruling: Second Wind 4 uses (a new uses_max in features_add changes it)');
    expect(notices()[0]).not.toContain('feature uses now: Second Wind');
  });

  it('tells apart two takings of a feat whose uses both grew, in the summary and the DM notice (SRD 5.2.1 Feats: Repeatable)', async () => {
    const user = userEvent.setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const taking = (id: string, level: number) => ({
      id,
      name: 'Wick Tender',
      source: 'feat' as const,
      sourceName: `Ability Score Improvement (Fighter ${level})`,
      description: 'Invented: you can use this benefit a number of times equal to your Proficiency Bonus, and you regain all expended uses when you finish a Long Rest.',
      uses: { max: 3, used: 0, recharge: 'long' as const },
    });
    resetFakeGame({ campaign: sampleCampaign(), character: { ...fighter(8, { subclass: 'Champion', subclassId: 'srd:subclass:champion' }), features: [taking('a', 4), taking('b', 8)] } });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    const lines = ['Wick Tender (Ability Score Improvement (Fighter 4)) 3 → 4', 'Wick Tender (Ability Score Improvement (Fighter 8)) 3 → 4'];
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(expect.arrayContaining(lines));
    expect(notices()[0]).toContain(`feature uses now: ${lines.join(', ')}`);
    // Two nothing tells apart (both the DM's): two like lines, each its own list item.
    cleanup();
    const alike = (id: string) => ({ ...taking(id, 4), sourceName: 'Granted in play' });
    resetFakeGame({ campaign: sampleCampaign(), character: { ...fighter(8, { subclass: 'Champion', subclassId: 'srd:subclass:champion' }), features: [alike('a'), alike('b')] } });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(screen.getAllByRole('listitem').filter((li) => li.textContent === 'Wick Tender 3 → 4')).toHaveLength(2);
    expect(errors.mock.calls.some((args) => args.some((a) => String(a).includes('same key')))).toBe(false);
    errors.mockRestore();
  });

  it("puts a feat named like a species trait beside it: the trait keeps its text, source and ref", async () => {
    const user = userEvent.setup();
    const trait = {
      id: 't-lantern',
      name: 'Lantern Bearer',
      source: 'species' as const,
      sourceName: 'Mothkin',
      description: 'Invented: a moth-folk trait of the same name.',
      ref: importedRef({ entryId: 'lib:gloam:species:mothkin', kind: 'species', entryName: 'Mothkin', part: 'Lantern Bearer', textHash: 'h', textCopied: true }),
    };
    resetFakeGame({ campaign: sampleCampaign(), character: { ...fighter(3, { subclass: 'Champion', subclassId: 'srd:subclass:champion' }), features: [trait] } });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(screen.getByRole('radio', { name: 'Lantern Bearer' }));
    await user.selectOptions(screen.getByLabelText('Ability Lantern Bearer raises'), 'cha');
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(sheet().features.filter((f) => f.name === 'Lantern Bearer')).toEqual([
      trait,
      expect.objectContaining({ source: 'feat', sourceName: 'Ability Score Improvement (Fighter 4)', description: TEXT.lanternBearer.join('\n\n'), ref: expect.objectContaining({ kind: 'feat', entryName: 'Lantern Bearer' }) }),
    ]);
    expect(sheet().abilityScores.cha).toBe(9);
  });

  describe('a choice the panel no longer offers once the subclass changes', () => {
    // Invented subclasses whose 3rd level opens the panel: a Fighting Style, and an Ability Score Improvement.
    const duelist = { ...EMBER, id: 'lib:gloam:subclass:lamp-duelist', name: 'Lamp Duelist', features: [{ level: 3, name: 'Fighting Style', description: 'Invented: a Fighting Style feat.' }] };
    const scholar = { ...EMBER, id: 'lib:gloam:subclass:lamp-scholar', name: 'Lamp Scholar', features: [{ level: 3, name: 'Ability Score Improvement', description: 'Invented: an early feat.' }] };
    const subclass = (name: RegExp) => within(screen.getByRole('radiogroup', { name: 'Subclass' })).getByRole('radio', { name });
    beforeEach(() => {
      mocks.data = { ...EXPECTED_MERGED, classes: EXPECTED_MERGED.classes.map((c) => (c.id === FIGHTER.id ? { ...c, subclasses: [...c.subclasses, duelist, scholar] } : c)) };
      // Chain Mail on: Defense would raise the AC.
      const mail = { id: 'mail', name: 'Chain Mail', category: 'armor' as const, quantity: 1, equipped: true };
      resetFakeGame({ campaign: sampleCampaign(), character: { ...fighter(2), inventory: [mail], armorClass: 16, acFormula: 'Chain Mail 16' } });
    });

    it('drops a Fighting Style picked for a subclass whose level gives no feat choice', async () => {
      const user = userEvent.setup();
      render(<LevelUpDialog open onClose={() => undefined} />);
      await user.click(subclass(/Lamp Duelist/));
      await user.click(screen.getByRole('radio', { name: /^Defense/ }));
      await user.click(subclass(/Champion/));
      expect(screen.queryByRole('radio', { name: /^Defense/ })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Level up' }));
      expect(sheet().classes[0]).toMatchObject({ level: 3, subclass: 'Champion' });
      expect(sheet().features.map((f) => f.name)).not.toContain('Defense');
      expect(sheet().armorClass).toBe(16);
      expect(notices()[0]).not.toContain('Defense');
    });

    it("shows and applies “Decide with my DM” when the new panel doesn't list the choice", async () => {
      const user = userEvent.setup();
      render(<LevelUpDialog open onClose={() => undefined} />);
      // A Fighting Style feat, then an Ability Score Improvement panel: no Fighting Style feats for this hero, who has no
      // Fighting Style feature.
      await user.click(subclass(/Lamp Duelist/));
      await user.click(screen.getByRole('radio', { name: /^Defense/ }));
      await user.click(subclass(/Lamp Scholar/));
      expect(screen.getByRole('radio', { name: 'Decide with my DM' })).toBeChecked();
      // +2 to one ability, then a panel without score increases.
      await user.click(screen.getByRole('radio', { name: '+2 to one ability' }));
      await user.selectOptions(screen.getByLabelText('Ability to raise by 2'), 'str');
      await user.click(subclass(/Lamp Duelist/));
      expect(screen.getByRole('radio', { name: 'Decide with my DM' })).toBeChecked();
      expect(screen.getByRole('radio', { name: /^Defense/ })).not.toBeChecked();
      await user.click(screen.getByRole('button', { name: 'Level up' }));
      expect(sheet().abilityScores.str).toBe(16);
      expect(sheet().features.map((f) => f.name)).not.toContain('Defense');
      expect(sheet().armorClass).toBe(16);
      expect(notices()[0]).not.toMatch(/feat: Defense|chose: \+2/);
    });
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

  it("offers the subclasses a 2024 book's Fighter and the SRD Fighter share (each class's own first) and keeps the one chosen by id", async () => {
    const user = userEvent.setup();
    const nightWard = { ...EMBER, id: 'lib:gloam:subclass:night-ward', name: 'Night Ward' };
    const bookFighter: ClassOption = {
      ...FIGHTER,
      id: 'lib:gloam:class:fighter',
      subclasses: [nightWard],
      sharedSubclasses: [...FIGHTER.subclasses],
      source: { sourceId: 'gloam', title: GLOAMWOOD_TITLE, recordId: 'rec:gloam:class:fighter', format: '2024', adaptations: [] },
    };
    mocks.data = { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes.map((c) => (c.id === FIGHTER.id ? { ...c, sharedSubclasses: [nightWard] } : c)), bookFighter] };
    const radios = () => within(screen.getByRole('radiogroup', { name: 'Subclass' })).getAllByRole('radio');
    // A hero made before the book, on the SRD Fighter: its own, then the book's.
    render(<LevelUpDialog open onClose={() => undefined} />);
    expect(radios()).toHaveLength(3);
    [/^Champion/, /^Ember Warden/, /^Night Ward/].forEach((name, i) => expect(radios()[i]).toHaveAccessibleName(name));
    await user.click(radios()[2]);
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(sheet().classes[0]).toMatchObject({ classId: FIGHTER.id, level: 3, subclass: 'Night Ward', subclassId: nightWard.id });
    cleanup();
    // Its later features arrive by that id, under the SRD Fighter.
    resetFakeGame({ campaign: sampleCampaign(), character: fighter(6, { subclass: 'Night Ward', subclassId: nightWard.id }) });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(sheet().features.map((f) => f.name)).toContain('Smoke Step');
    cleanup();
    // A hero on the book's Fighter: the book's own, then the SRD Fighter's.
    resetFakeGame({ campaign: sampleCampaign(), character: hero({ classId: bookFighter.id, name: 'Fighter', level: 2, hitDie: 10 }) });
    render(<LevelUpDialog open onClose={() => undefined} />);
    [/^Night Ward/, /^Champion/, /^Ember Warden/].forEach((name, i) => expect(radios()[i]).toHaveAccessibleName(name));
    await user.click(radios()[1]);
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(sheet().classes[0]).toMatchObject({ classId: bookFighter.id, level: 3, subclass: 'Champion', subclassId: 'srd:subclass:champion' });
    cleanup();
    // The book's class renamed in review: the classes no longer share, and the hero's subclass stays theirs (by id).
    mocks.data = { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, { ...bookFighter, name: 'Fighter (Gloamwood)', sharedSubclasses: undefined }] };
    resetFakeGame({ campaign: sampleCampaign(), character: fighter(6, { subclass: 'Night Ward', subclassId: nightWard.id }) });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(sheet().features.map((f) => f.name)).toContain('Smoke Step');
  });

  it("offers a 2024 book's class and subclass in place of the SRD's of their names; a hero on the book's class sees no SRD note", async () => {
    const book = { sourceId: 'gloam', title: GLOAMWOOD_TITLE, format: '2024' as const, adaptations: [] };
    const bookCleric: ClassOption = { ...CLERIC, id: 'lib:gloam:class:cleric', subclasses: [], source: { ...book, recordId: 'rec:gloam:class:cleric' } };
    const champion = FIGHTER.subclasses.find((s) => s.name === 'Champion')!;
    const bookChampion = { ...EMBER, id: 'lib:gloam:subclass:champion', name: 'Champion' };
    mocks.data = {
      ...EXPECTED_MERGED,
      classes: [...EXPECTED_MERGED.classes.map((c) => (c.id === FIGHTER.id ? { ...c, subclasses: [...c.subclasses, bookChampion] } : c)), bookCleric],
    };
    render(<LevelUpDialog open onClose={() => undefined} />);
    const select = screen.getByLabelText('Or multiclass into');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a new class…', `Wickwright · ${GLOAMWOOD_TITLE} (d8)`, `Cleric · ${GLOAMWOOD_TITLE} (d8)`]);
    const champions = within(screen.getByRole('radiogroup', { name: 'Subclass' })).getAllByRole('radio', { name: /Champion/ });
    expect(champions).toHaveLength(1);
    expect(within(champions[0]).getByText(`From ${GLOAMWOOD_TITLE}`)).toBeInTheDocument();
    expect(champion.source).toBeUndefined();
    cleanup();
    // A hero on the book's Cleric: the SRD Cleric is neither offered nor noted ("isn't offered" is for a book's class).
    resetFakeGame({ campaign: sampleCampaign(), character: hero({ classId: bookCleric.id, name: 'Cleric', level: 2, hitDie: 8 }) });
    render(<LevelUpDialog open onClose={() => undefined} />);
    expect(screen.queryByText(/Cleric \(SRD 5\.2\.1\) isn't offered/)).toBeNull();
    expect(within(screen.getByLabelText('Or multiclass into')).queryByText(/^Cleric/)).toBeNull();
  });

  it("tells the DM when the hero doesn't meet a book class's multiclass prerequisites, as for the SRD's", async () => {
    const user = userEvent.setup();
    const bookCleric: ClassOption = { ...CLERIC, id: 'lib:gloam:class:cleric', subclasses: [], source: { sourceId: 'gloam', title: GLOAMWOOD_TITLE, recordId: 'rec:gloam:class:cleric', format: '2024', adaptations: [] } };
    mocks.data = { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, bookCleric] };
    const start = fighter(3, { subclass: 'Champion', subclassId: 'srd:subclass:champion' });
    resetFakeGame({ campaign: sampleCampaign(), character: { ...start, abilityScores: { ...start.abilityScores, wis: 8 } } });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.selectOptions(screen.getByLabelText('Or multiclass into'), `Cleric · ${GLOAMWOOD_TITLE} (d8)`);
    await user.click(screen.getByLabelText('My DM allows it anyway'));
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(notices()[0]).toMatch(/Multiclass prerequisite not met: Cleric needs 13\+ \(Wisdom 8\)/);
  });

  it('focuses the Summary\'s first line when it takes the form\'s place, so it is read and Tab goes on to Done', async () => {
    const user = userEvent.setup();
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(within(screen.getByRole('radiogroup', { name: 'Subclass' })).getByRole('radio', { name: /Champion/ }));
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(await screen.findByText('Level 3!')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus();
  });

  it('lists each prerequisite class once while the Summary is swapped in (no duplicate keys)', async () => {
    const user = userEvent.setup();
    const error = vi.spyOn(console, 'error');
    resetFakeGame({ campaign: sampleCampaign(), character: fighter(3, { subclass: 'Champion', subclassId: 'srd:subclass:champion' }) });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.selectOptions(screen.getByLabelText('Or multiclass into'), `Wickwright · ${GLOAMWOOD_TITLE} (d8)`);
    await user.click(screen.getByLabelText('My DM allows it anyway'));
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(await screen.findByText('Level 4!')).toBeInTheDocument();
    expect(sheet().classes.map((cl) => cl.name)).toEqual(['Fighter', 'Wickwright']);
    expect(error.mock.calls.map((args) => args.join(' ')).filter((m) => /same key/.test(m))).toEqual([]);
  });

  it("says when an imported class's data isn't on this device", () => {
    const ref = { sourceId: 'other', sourceTitle: GLOAMWOOD_TITLE, entryId: 'lib:other:class:lampwright', kind: 'class' as const, entryName: 'Lampwright', textHash: '', textCopied: false };
    resetFakeGame({ campaign: sampleCampaign(), character: hero({ classId: ref.entryId, name: 'Lampwright', level: 2, hitDie: 8, ref }) });
    render(<LevelUpDialog open onClose={() => undefined} />);
    expect(screen.getByText(`Class data for Lampwright comes from “${GLOAMWOOD_TITLE}”, which isn't on this device; your DM can fill in its features.`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Level up' })).toBeEnabled();
  });
});

// The SRD's own class tables and spells (SRD 5.2.1, each class's Spellcasting), on the real engine.
describe("LevelUpDialog: the level's spells", () => {
  const SRD_SPELLS = (JSON.parse(compendiumRaw) as CompendiumEntry[]).filter((e) => e.kind === 'spell');
  const srdSpell = (name: string, source: string): KnownSpell => {
    const e = SRD_SPELLS.find((s) => s.name === name)!;
    return { id: e.id, name: e.name, level: Number(e.data?.level), prepared: true, source };
  };
  const group = (name: RegExp) => within(screen.getByRole('group', { name }));

  beforeEach(() => {
    mocks.data = SRD_BUILDER_DATA;
    mocks.spells = SRD_SPELLS;
  });

  it('says what the Wizard 4 chooses next, tells the DM in place of the generic reminder, and continues into the choices in this dialog (srd:rule:wizard-spellcasting)', async () => {
    const user = userEvent.setup();
    resetFakeGame({ campaign: sampleCampaign(), character: sampleCharacter() });
    const onClose = vi.fn();
    render(<LevelUpDialog open onClose={onClose} />);
    // The sample Wizard 3 holds 3 Wizard cantrips, a 6-spell book and 5 prepared: Wizard 4 has 4 cantrips, a book of at
    // least 12 ("add two Wizard spells … to your spellbook" each level after 1) and 7 prepared.
    expect(screen.getByText('Next: choose 1 cantrip, 6 spellbook spells and 2 prepared spells')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Level up' }));

    const notice = notices()[0];
    expect(notice).toMatch(/^Player leveled up to Wizard 4 \(character level 4\): \+5 HP \(max 22\); new features: [^;]+; spells to choose: 1 cantrip, 6 spellbook spells \(2 up to level 2 and 4 of level 1\) and 2 prepared spells; /);
    // A DM whose session began before its level_up said how still learns how to record what the player names.
    expect(notice).toContain(
      '; spells to choose: 1 cantrip, 6 spellbook spells (2 up to level 2 and 4 of level 1) and 2 prepared spells; if the player names them to you instead: update_character spells_add, source "Wizard" (prepared: false for a spell only added to the spellbook; a spell copied into it, or one a feature adds to it free: source "Wizard (copied)"; to prepare a spell already in it: re-add it by name with prepared true and no source); still to choose: ',
    );
    expect(notice).not.toContain('Review your Wizard cantrips and prepared spells');
    expect(sheet().spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:wizard' }]);

    // The Summary lists them, without the generic line in Still to do; its first line has focus, then Choose spells.
    expect(await screen.findByText('Wizard 4: choose 1 cantrip, 6 spellbook spells and 2 prepared spells')).toBeInTheDocument();
    expect(screen.queryByText(/Review your Wizard cantrips/)).toBeNull();
    expect(screen.getByText('Level 4!')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Choose spells' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Choose spells' }));

    // The same dialog: no dialog on top of it, and focus moves into the choices.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Choose spells' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Spell choices' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    await user.click(group(/^Cantrips/).getByRole('checkbox', { name: /^Ray of Frost/ }));
    await user.click(group(/^Spellbook/).getByRole('checkbox', { name: /^Web/ }));
    await user.click(group(/^Spellbook/).getByRole('checkbox', { name: /^Hold Person/ }));
    await user.click(group(/^Prepare from your spellbook/).getByRole('checkbox', { name: /^Web/ }));
    await user.click(group(/^Prepare from your spellbook/).getByRole('checkbox', { name: /^Sleep/ }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(notices()[1]).toBe('Player chose spells for Wizard 4: cantrip Ray of Frost; spellbook Web, Hold Person; prepared Web, Sleep; still to choose: 4 spellbook spells (4 of level 1)');
    expect(onClose).toHaveBeenCalled();
  });

  it('goes back to the lists on Escape or Android Back while a spell is read in the choices; from the lists it closes', async () => {
    const user = userEvent.setup();
    resetFakeGame({ campaign: sampleCampaign(), character: sampleCharacter() });
    const onClose = vi.fn();
    render(<LevelUpDialog open onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    await user.click(await screen.findByRole('button', { name: 'Choose spells' }));
    const dialog = screen.getByRole('dialog', { name: 'Choose spells' });
    await user.click(group(/^Cantrips/).getByRole('checkbox', { name: /^Ray of Frost/ }));
    const cancel = (cancelable: boolean) =>
      act(() => {
        fireEvent(dialog, new Event('cancel', { cancelable }));
        // A Back the page can't refuse: the browser closes the dialog anyway.
        if (!cancelable && dialog.hasAttribute('open')) {
          dialog.removeAttribute('open');
          fireEvent(dialog, new Event('close'));
        }
      });
    for (const request of [
      async () => {
        await user.keyboard('{Escape}');
        cancel(true);
      },
      () => cancel(true),
      () => cancel(false),
    ]) {
      await user.click(group(/^Cantrips/).getByRole('button', { name: 'About Ray of Frost' }));
      expect(screen.getByRole('region', { name: 'Ray of Frost' })).toBeInTheDocument();
      await request();
      expect(screen.queryByRole('region', { name: 'Ray of Frost' })).toBeNull();
      expect(group(/^Cantrips/).getByRole('button', { name: 'About Ray of Frost' })).toHaveFocus();
      expect(group(/^Cantrips/).getByRole('checkbox', { name: /^Ray of Frost/ })).toBeChecked();
      expect(screen.getByRole('dialog', { name: 'Choose spells' })).toHaveAttribute('open');
    }
    expect(onClose).not.toHaveBeenCalled();
    cancel(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(notices()).toHaveLength(1);
  });

  it("goes back to the Summary from the choices, which stay open (Cancel)", async () => {
    const user = userEvent.setup();
    resetFakeGame({ campaign: sampleCampaign(), character: sampleCharacter() });
    const onClose = vi.fn();
    render(<LevelUpDialog open onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    await user.click(await screen.findByRole('button', { name: 'Choose spells' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: 'Level up' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose spells' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(notices()).toHaveLength(1);
    expect(sheet().spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:wizard' }]);
  });

  it("turns a Life Cleric's Bless and Cure Wounds always prepared, adds the rest, and owes the places they free (srd:rule:cleric-life-domain-spells, srd:rule:gaining-spells)", async () => {
    const user = userEvent.setup();
    // A Cleric 2 built with the recommended spells (srd:rule:cleric-spellcasting: "Bless, Cure Wounds, Guiding Bolt, and
    // Shield of Faith are recommended") and Sanctuary at level 2. Life Domain's level 3 row grants Aid, Bless, Cure Wounds
    // and Lesser Restoration: "you thereafter always have the listed spells prepared", which "doesn't count against the
    // number of spells on that list".
    const spells = [
      ...['Guidance', 'Sacred Flame', 'Thaumaturgy', 'Bless', 'Cure Wounds', 'Guiding Bolt', 'Shield of Faith', 'Sanctuary'].map((n) => srdSpell(n, 'Cleric')),
    ];
    const cleric = hero(
      { classId: 'srd:class:cleric', name: 'Cleric', level: 2, hitDie: 8, casterType: 'full', spellcastingAbility: 'wis' },
      { spellcasting: { ability: 'wis', slots: { 1: { max: 3, used: 0 } }, spells, concentratingOn: null } },
    );
    resetFakeGame({ campaign: sampleCampaign(), character: cleric });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(within(screen.getByRole('radiogroup', { name: 'Subclass' })).getByRole('radio', { name: /Life Domain/ }));
    expect(screen.getByText('Always prepared from Life Domain: Aid, Lesser Restoration')).toBeInTheDocument();
    expect(screen.getByText('Now always prepared from Life Domain: Bless, Cure Wounds')).toBeInTheDocument();
    // Cleric 3 prepares 6: three of the five picks stay counted. "Whenever you gain a Cleric level, you can replace one
    // of your cantrips".
    expect(screen.getByText('Next: choose 3 prepared spells; you may also replace a cantrip')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(notices()[0]).toContain(
      '; subclass Life Domain; new features: Cleric Subclass, Disciple of Life, Life Domain Spells, Preserve Life; always prepared: Aid, Lesser Restoration; now always prepared: Bless, Cure Wounds; spells to choose: 3 prepared spells (may also replace one cantrip)',
    );
    const bless = sheet().spellcasting?.spells.find((s) => s.name === 'Bless');
    expect(bless).toMatchObject({ id: 'srd:spell:bless', alwaysPrepared: true, prepared: true, source: 'Life Domain' });
    expect(sheet().spellcasting?.spells.find((s) => s.name === 'Aid')).toMatchObject({ alwaysPrepared: true, source: 'Life Domain' });
    expect(sheet().spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:cleric', replaceCantrip: true }]);
    expect(await screen.findByText('Cleric 3: choose 3 prepared spells; you may also replace a cantrip')).toBeInTheDocument();
  });

  it('drops the generic line for a level the table can count that owes nothing, and adds what the class always has prepared (Paladin 6)', async () => {
    const user = userEvent.setup();
    // Paladin 5 → 6: the Prepared Spells column stays at 6, no cantrips, no swap on a level (srd:rule:paladin-spellcasting).
    // Its own spells are none of those it always has prepared (srd:rule:paladin-s-smite: "You always have the Divine Smite
    // spell prepared"; Faithful Steed's Find Steed; the Oath of Devotion's table).
    const own = ['Bless', 'Cure Wounds', 'Heroism', 'Command', 'Searing Smite', 'Warding Bond'].map((n) => srdSpell(n, 'Paladin'));
    const paladin = hero(
      { classId: 'srd:class:paladin', name: 'Paladin', level: 5, hitDie: 10, casterType: 'half', spellcastingAbility: 'cha', subclass: 'Oath of Devotion' },
      { spellcasting: { ability: 'cha', slots: { 1: { max: 4, used: 0 }, 2: { max: 2, used: 0 } }, spells: own, concentratingOn: null } },
    );
    resetFakeGame({ campaign: sampleCampaign(), character: paladin });
    render(<LevelUpDialog open onClose={() => undefined} />);
    expect(screen.getByText("Always prepared from Paladin's Smite: Divine Smite")).toBeInTheDocument();
    expect(screen.getByText('Always prepared from Oath of Devotion: Protection from Evil and Good, Shield of Faith, Aid, Zone of Truth')).toBeInTheDocument();
    expect(screen.queryByText(/^Next:/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(notices()[0]).toContain('always prepared: Divine Smite, Find Steed, Protection from Evil and Good, Shield of Faith, Aid, Zone of Truth');
    expect(notices()[0]).not.toMatch(/spells to choose|Review your Paladin/);
    expect(sheet().spellcasting?.spellPicks).toBeUndefined();
    expect(await screen.findByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choose spells' })).toBeNull();
  });

  const srdClass = (name: string) => SRD_BUILDER_DATA.classes.find((c) => c.name === name)!;
  const srdEntry = (name: string, level: number, extra: Partial<ClassLevel> = {}): ClassLevel => {
    const o = srdClass(name);
    return { classId: o.id, name: o.name, level, hitDie: o.hitDie, casterType: o.casterType, ...(o.spellcastingAbility ? { spellcastingAbility: o.spellcastingAbility } : {}), ...extra };
  };
  /** `n` placeholder spells of a level for a class: what counts, nothing an always-prepared grant names. */
  const fill = (className: string, n: number, level: number): KnownSpell[] =>
    Array.from({ length: n }, (_, i) => ({ id: `fill-${className}-${level}-${i}`, name: `${className} spell ${level}-${i}`, level, prepared: true, source: className }));
  /** A Paladin 2 / Cleric 1 at both tables, Shield of Faith among the Cleric's prepared spells. */
  const paladinCleric = (paladinPrepared = preparedSpellCount(srdClass('Paladin'), 2)): Character =>
    hero(srdEntry('Paladin', 2), {
      classes: [srdEntry('Paladin', 2), srdEntry('Cleric', 1)],
      hitDice: [
        { die: 10, total: 2, spent: 0 },
        { die: 8, total: 1, spent: 0 },
      ],
      abilityScores: { str: 16, dex: 10, con: 13, int: 8, wis: 13, cha: 14 },
      spellcasting: {
        ability: 'cha',
        slots: { 1: { max: 3, used: 0 } },
        spells: [
          ...fill('Cleric', cantripsKnown(srdClass('Cleric'), 1), 0),
          srdSpell('Shield of Faith', 'Cleric'),
          ...fill('Cleric', preparedSpellCount(srdClass('Cleric'), 1) - 1, 1),
          ...fill('Paladin', paladinPrepared, 1),
          { ...srdSpell('Divine Smite', "Paladin's Smite"), alwaysPrepared: true },
        ],
        concentratingOn: null,
      },
    });

  it("names the class whose list a turned spell leaves, and leaves that class's choices open too (srd:rule:gaining-spells)", async () => {
    const user = userEvent.setup();
    // Oath of Devotion's Paladin 3 row: Protection from Evil and Good, Shield of Faith — "you thereafter always have the
    // listed spells prepared", and "a spell that you always have prepared doesn't count against the number of spells on
    // that list": the Cleric's place is free again, and the Paladin 3 prepares one more (3 → 4).
    resetFakeGame({ campaign: sampleCampaign(), character: paladinCleric() });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(within(screen.getByRole('radiogroup', { name: 'Subclass' })).getByRole('radio', { name: /Oath of Devotion/ }));
    expect(screen.getByText('Always prepared from Oath of Devotion: Protection from Evil and Good')).toBeInTheDocument();
    expect(screen.getByText('Now always prepared from Oath of Devotion: Shield of Faith')).toHaveTextContent(
      'Now always prepared from Oath of Devotion: Shield of Faith — no longer counted among your Cleric prepared spells',
    );
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(notices()[0]).toContain(
      '; now always prepared: Shield of Faith; spells to choose: 1 prepared spell; if the player names them to you instead: update_character spells_add, source "Paladin"; Cleric 1 spells to choose: 1 prepared spell; if the player names them to you instead: update_character spells_add, source "Cleric"',
    );
    expect(sheet().spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:paladin' }, { classId: 'srd:class:cleric' }]);
    // The Summary lists both; Choose spells opens the levelled class's choices first.
    expect(await screen.findByText('Paladin 3: choose 1 prepared spell')).toBeInTheDocument();
    expect(screen.getByText('Cleric 1: choose 1 prepared spell')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choose spells' }));
    expect(screen.getByRole('region', { name: 'Spell choices' })).toHaveTextContent(/^Paladin 3/);
  });

  it("opens another class's choices from the Summary when the levelled class owes nothing", async () => {
    const user = userEvent.setup();
    // The Paladin already holds the Paladin 3 count: only the Cleric's turned Shield of Faith leaves a place to fill.
    resetFakeGame({ campaign: sampleCampaign(), character: paladinCleric(preparedSpellCount(srdClass('Paladin'), 3)) });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(within(screen.getByRole('radiogroup', { name: 'Subclass' })).getByRole('radio', { name: /Oath of Devotion/ }));
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(notices()[0]).toContain('; now always prepared: Shield of Faith; Cleric 1 spells to choose: 1 prepared spell');
    expect(notices()[0]).not.toContain('; spells to choose');
    expect(await screen.findByText('Cleric 1: choose 1 prepared spell')).toBeInTheDocument();
    expect(screen.queryByText(/^Paladin 3:/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Choose spells' }));
    expect(screen.getByRole('region', { name: 'Spell choices' })).toHaveTextContent(/^Cleric 1/);
  });

  it('says a turned spellbook spell stays in the book (srd:rule:wizard-spellcasting, Fiend Patron spells)', async () => {
    const user = userEvent.setup();
    // Mira (Wizard 3, Scorching Ray in her book and prepared) with Warlock 2 gains Warlock 3 and the Fiend Patron, whose
    // level 3 row lists Burning Hands, Command, Scorching Ray and Suggestion. "The book contains the level 1+ spells you
    // know": Scorching Ray stays in it, no longer one of her prepared Wizard spells.
    const mira = sampleCharacter();
    const multi: Character = {
      ...mira,
      classes: [srdEntry('Warlock', 2), ...mira.classes],
      hitDice: [...mira.hitDice, { die: 8, total: 2, spent: 0 }],
      abilityScores: { ...mira.abilityScores, cha: 13 },
      spellcasting: { ...mira.spellcasting!, spells: [...mira.spellcasting!.spells, ...fill('Warlock', 2, 0), ...fill('Warlock', 3, 1)] },
    };
    resetFakeGame({ campaign: sampleCampaign(), character: multi });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(within(screen.getByRole('radiogroup', { name: 'Subclass' })).getByRole('radio', { name: /Fiend Patron/ }));
    expect(screen.getByText('Now always prepared from Fiend Patron: Scorching Ray')).toHaveTextContent(
      'Now always prepared from Fiend Patron: Scorching Ray — no longer counted among your Wizard prepared spells; it stays in your spellbook',
    );
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(sheet().spellcasting?.spells.find((s) => s.name === 'Scorching Ray')).toMatchObject({ alwaysPrepared: true, source: 'Wizard' });
    // Her Wizard 3 now prepares 4 of 6, and her book (6 of 10, a hero from before the choices were counted) catches up.
    expect(notices()[0]).toContain('; now always prepared: Scorching Ray; spells to choose: 1 prepared spell (may also replace one spell and one cantrip); ');
    // With the book's limits by level, as level_up's line gives them: her two level 2 spells took Wizard 3's places.
    expect(notices()[0]).toContain('; Wizard 3 spells to choose: 4 spellbook spells (4 of level 1) and 2 prepared spells;');
    expect(await screen.findByText('Warlock 3: choose 1 prepared spell; you may also replace a spell and a cantrip')).toBeInTheDocument();
    expect(screen.getByText('Wizard 3: choose 4 spellbook spells and 2 prepared spells')).toBeInTheDocument();
  });

  it('says only that a turned spellbook spell stays in the book when it was not prepared (srd:rule:gaining-spells)', async () => {
    const user = userEvent.setup();
    // Unprepared, Scorching Ray wasn't one of her prepared Wizard spells, so it frees no place there.
    const mira = sampleCharacter();
    const unprepared = mira.spellcasting!.spells.map((s) => (s.name === 'Scorching Ray' ? { ...s, prepared: false } : s));
    const multi: Character = {
      ...mira,
      classes: [srdEntry('Warlock', 2), ...mira.classes],
      hitDice: [...mira.hitDice, { die: 8, total: 2, spent: 0 }],
      abilityScores: { ...mira.abilityScores, cha: 13 },
      spellcasting: { ...mira.spellcasting!, spells: [...unprepared, ...fill('Warlock', 2, 0), ...fill('Warlock', 3, 1)] },
    };
    resetFakeGame({ campaign: sampleCampaign(), character: multi });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(within(screen.getByRole('radiogroup', { name: 'Subclass' })).getByRole('radio', { name: /Fiend Patron/ }));
    expect(screen.getByText('Now always prepared from Fiend Patron: Scorching Ray')).toHaveTextContent(/^Now always prepared from Fiend Patron: Scorching Ray — it stays in your spellbook$/);
  });

  it("waits for the rules index on a quick Level up, so a granted spell isn't skipped (srd:rule:paladin-s-smite)", async () => {
    const user = userEvent.setup();
    // Paladin 2: "You always have the Divine Smite spell prepared." The rules index isn't built yet when the dialog opens.
    mocks.indexReady = false;
    const paladin = hero(srdEntry('Paladin', 1), {
      spellcasting: { ability: 'cha', slots: { 1: { max: 2, used: 0 } }, spells: fill('Paladin', preparedSpellCount(srdClass('Paladin'), 1), 1), concentratingOn: null },
    });
    resetFakeGame({ campaign: sampleCampaign(), character: paladin });
    render(<LevelUpDialog open onClose={() => undefined} />);
    // Loading isn't missing: no "Not in your rules yet" while the index builds.
    expect(screen.getByRole('heading', { name: 'New at Paladin level 2' })).toBeInTheDocument();
    expect(screen.queryByText(/Not in your rules yet/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(sheet().spellcasting?.spells.find((s) => s.name === 'Divine Smite')).toMatchObject({ id: 'srd:spell:divine-smite', alwaysPrepared: true, source: "Paladin's Smite" });
    expect(notices()[0]).toContain("; always prepared: Divine Smite; spells to choose: 1 prepared spell");
    expect(notices()[0]).not.toContain('not added');
  });

  it('names a granted spell it could not add for the DM when the rules index fails', async () => {
    const user = userEvent.setup();
    mocks.indexReady = false;
    mocks.indexFails = true;
    const paladin = hero(srdEntry('Paladin', 1), {
      spellcasting: { ability: 'cha', slots: { 1: { max: 2, used: 0 } }, spells: fill('Paladin', preparedSpellCount(srdClass('Paladin'), 1), 1), concentratingOn: null },
    });
    resetFakeGame({ campaign: sampleCampaign(), character: paladin });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(sheet().spellcasting?.spells.some((s) => s.name === 'Divine Smite')).toBe(false);
    expect(notices()[0]).toContain("; not added (not in the rules here; add with the source named, not a class's name): Divine Smite (Paladin's Smite); spells to choose: 1 prepared spell");
  });

  /** A Paladin 1 at its table, slots and all. */
  const paladin1 = () =>
    hero(srdEntry('Paladin', 1), {
      spellcasting: { ability: 'cha', slots: { 1: { max: 2, used: 0 } }, spells: fill('Paladin', preparedSpellCount(srdClass('Paladin'), 1), 1), concentratingOn: null },
    });
  /** Holds getRulesIndex until the returned function is called. */
  const holdIndex = (): (() => Promise<void>) => {
    mocks.indexReady = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.indexGate = gate;
    return async () => {
      await act(async () => {
        release();
        await gate;
      });
    };
  };
  function Reopenable() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open level up
        </button>
        <LevelUpDialog open={open} onClose={() => setOpen(false)} />
      </>
    );
  }

  it('levels the hero once when the dialog is reopened while a Level up waits for the rules index', async () => {
    const user = userEvent.setup();
    const release = holdIndex();
    resetFakeGame({ campaign: sampleCampaign(), character: paladin1() });
    render(<Reopenable />);
    const button = screen.getByRole('button', { name: 'Level up' });
    await user.click(button);
    // Waiting: the button keeps focus and says so, and can't be pressed again.
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Leveling up…')).toBeInTheDocument();
    // Closed meanwhile, the Level up still applies; reopened, the dialog shows the wait rather than the same level again.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open level up' }));
    const again = within(screen.getByRole('dialog', { name: 'Level up' })).getByRole('button', { name: 'Level up' });
    expect(again).toHaveAttribute('aria-disabled', 'true');
    await user.click(again);
    await release();
    expect(sheet().classes[0].level).toBe(2);
    expect(sheet().features.filter((f) => f.name === "Paladin's Smite")).toHaveLength(1);
    expect(notices()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Level up' })).not.toHaveAttribute('aria-disabled');
  });

  it("doesn't apply a plan for a level the hero passed while it waited (the DM's level_up)", async () => {
    const user = userEvent.setup();
    const release = holdIndex();
    resetFakeGame({ campaign: sampleCampaign(), character: paladin1() });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    act(() => useGame.setState({ character: levelUp(sheet(), { className: 'Paladin', classId: 'srd:class:paladin', hpMethod: 'average' }).character }));
    const info = vi.spyOn(toast, 'info');
    await release();
    expect(sheet().classes[0].level).toBe(2);
    expect(notices()).toEqual([]);
    expect(info).toHaveBeenCalledWith('Not applied: your character reached level 2 while this level-up waited. Open Level up again for the next level.');
  });

  it('tells the DM how to record a swap the player names when nothing new is owed (srd:rule:bard-spellcasting)', async () => {
    const user = userEvent.setup();
    // Bard 11 → 12: the table doesn't grow (4 cantrips, 16 prepared); "Whenever you gain a Bard level, you can replace one
    // spell on your list", and one cantrip.
    const BARD = srdClass('Bard');
    const bard = hero(srdEntry('Bard', 11, { subclass: 'College of Lore' }), {
      spellcasting: { ability: 'cha', slots: {}, spells: [...fill('Bard', cantripsKnown(BARD, 12), 0), ...fill('Bard', preparedSpellCount(BARD, 12), 1)], concentratingOn: null },
    });
    resetFakeGame({ campaign: sampleCampaign(), character: bard });
    render(<LevelUpDialog open onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Level up' }));
    expect(notices()[0]).toContain(
      '; spells to choose: none new (may replace one spell and one cantrip); if the player names them to you instead: update_character spells_add, source "Bard", and spells_remove for one they give up',
    );
    expect(await screen.findByText('Bard 12: you may replace a spell and a cantrip')).toBeInTheDocument();
  });
});
