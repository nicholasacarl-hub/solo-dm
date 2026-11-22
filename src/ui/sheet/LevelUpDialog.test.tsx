/**
 * The level-up dialog with the player's books (spec §5.4, §8.3): the real engine, the merged builder data
 * of the invented Gloamwood fixture (SRD Cleric and Fighter + the book), a fake game store.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { levelUp } from '@/engine';
import { useGame } from '@/state/gameStore';
import { sampleCampaign, sampleCharacter } from '@/test/fixtures';
import { DUSK_DOMAIN_MERGE_ADAPTATIONS, EXPECTED_MERGED, GLOAMWOOD_TITLE, TEXT, importedRef } from '@/test/structuredFixtures';
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
      // A Fighting Style feat, then a panel of General feats.
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

  it("says when an imported class's data isn't on this device", () => {
    const ref = { sourceId: 'other', sourceTitle: GLOAMWOOD_TITLE, entryId: 'lib:other:class:lampwright', kind: 'class' as const, entryName: 'Lampwright', textHash: '', textCopied: false };
    resetFakeGame({ campaign: sampleCampaign(), character: hero({ classId: ref.entryId, name: 'Lampwright', level: 2, hitDie: 8, ref }) });
    render(<LevelUpDialog open onClose={() => undefined} />);
    expect(screen.getByText(`Class data for Lampwright comes from “${GLOAMWOOD_TITLE}”, which isn't on this device; your DM can fill in its features.`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Level up' })).toBeEnabled();
  });
});
