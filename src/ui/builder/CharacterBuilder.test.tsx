/**
 * The character builder with the player's books (spec §5.3, §8.3): book badges and the SRD badge on a
 * clash, the source filter (and "Let the DM decide" choosing among what it shows), the pending-review
 * hint, an older background's any-three abilities and Origin-feat picker, a level-1 subclass picker, a
 * stale imported id, and the Review step's provenance line and older-edition notes. The real engine; the
 * merged data of the invented Gloamwood fixture.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleCampaign } from '@/test/fixtures';
import { EXPECTED_MERGED, GLOAMWOOD_TITLE } from '@/test/structuredFixtures';
import type { BackgroundOption, BuilderData, ClassOption, CompendiumEntry, FeatOption, SpeciesOption, StructuredKind } from '@/types';
import { resetFakeGame } from '@/ui/builder/testing/fakeGameStore';
import { autoCleanup, renderRoute } from '@/ui/shell/testUtils';
import { CharacterBuilder } from './CharacterBuilder';
import { spellInfo, type SpellInfo } from './spells';
import { emptyDraft, type BuilderDraft } from './types';
import { writeDraft } from './useBuilderDraft';

const mocks = vi.hoisted(() => ({ pending: [] as { sourceId: string; title: string; kind: StructuredKind; count: number }[] }));

vi.mock('@/images', () => import('@/ui/play/testing/imagesMock'));
vi.mock('@/state/gameStore', async () => (await import('@/ui/builder/testing/fakeGameStore')).fakeGameStoreModule());
vi.mock('@/data', async () => {
  const { EXPECTED_MERGED: data } = await import('@/test/structuredFixtures');
  const index = { get: () => undefined, findByName: () => undefined, list: () => [] };
  return {
    getBuilderProblems: () => [],
    countUnreviewedOptions: async () => mocks.pending,
    useBuilderData: () => ({ data, error: null, loading: false }),
    loadBuilderData: async () => data,
    useRulesIndex: () => index,
    useRulesIndexState: () => ({ index, loading: false, error: null }),
    getRulesIndex: async () => index,
  };
});

const campaign = sampleCampaign();
const NO_SPELLS = { spells: [], loading: false, error: null };
const byName = <T extends { name: string }>(list: readonly T[], name: string) => list.find((o) => o.name === name) as T;
const FIGHTER = byName(EXPECTED_MERGED.classes, 'Fighter');
const WICKWRIGHT = byName(EXPECTED_MERGED.classes, 'Wickwright');

function renderBuilder(draft: Partial<BuilderDraft> = {}, data: BuilderData = EXPECTED_MERGED, spells: SpellInfo[] = []) {
  writeDraft(campaign.id, { ...emptyDraft(), ...draft });
  return renderRoute(<CharacterBuilder campaign={campaign} data={data} spells={{ ...NO_SPELLS, spells }} onSave={async () => undefined} />);
}
const radio = (group: string, name: RegExp | string) => within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name });

autoCleanup();
beforeEach(() => {
  mocks.pending = [];
  sessionStorage.clear();
  resetFakeGame({ campaign, character: null });
});

describe('CharacterBuilder with imported options', () => {
  it('badges imported options with their book, and an SRD option when an import of its name is listed too', () => {
    const olderFighter: ClassOption = { ...WICKWRIGHT, id: 'lib:gloam:class:fighter', name: 'Fighter', subclasses: [], source: { ...WICKWRIGHT.source!, format: '2014' } };
    renderBuilder({}, { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, olderFighter] });
    expect(within(radio('Class', /Wickwright/)).getByText(`From ${GLOAMWOOD_TITLE}`)).toBeInTheDocument();
    const fighters = within(screen.getByRole('radiogroup', { name: 'Class' })).getAllByRole('radio', { name: /Fighter/ });
    expect(fighters).toHaveLength(2);
    expect(within(fighters[0]).getByText('SRD')).toBeInTheDocument();
    expect(within(fighters[1]).getByText(`From ${GLOAMWOOD_TITLE}`)).toBeInTheDocument();
    expect(within(radio('Class', /Cleric/)).queryByText('SRD')).toBeNull();
  });

  it('lists a 2024 book’s class in place of the SRD class of its name; the SRD filter and a chosen SRD class still show it', async () => {
    const user = userEvent.setup();
    const bookFighter: ClassOption = { ...WICKWRIGHT, id: 'lib:gloam:class:fighter', name: 'Fighter', subclasses: [] };
    expect(bookFighter.source?.format).toBe('2024');
    const data = { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, bookFighter] };
    const fighters = () => within(screen.getByRole('radiogroup', { name: 'Class' })).getAllByRole('radio', { name: /Fighter/ });
    const view = renderBuilder({}, data);
    expect(fighters()).toHaveLength(1);
    expect(within(fighters()[0]).getByText(`From ${GLOAMWOOD_TITLE}`)).toBeInTheDocument();
    await user.click(within(screen.getByRole('radiogroup', { name: 'Show options from' })).getByRole('radio', { name: 'SRD' }));
    expect(fighters()).toHaveLength(1);
    expect(within(fighters()[0]).getByText('SRD')).toBeInTheDocument();
    view.unmount();
    renderBuilder({ classId: FIGHTER.id }, data);
    expect(fighters()).toHaveLength(2);
    expect(fighters()[0]).toHaveAttribute('aria-checked', 'true');
  });

  it("offers a 2024 book's Fighting Style in place of the SRD's of its name, and keeps a chosen SRD style", () => {
    const hooked = byName(EXPECTED_MERGED.feats, 'Hooked Reach');
    const bookDefense: FeatOption = { ...hooked, id: 'lib:gloam:feat:defense', name: 'Defense', description: 'Invented: a lantern-lit guard.' };
    const data = { ...EXPECTED_MERGED, feats: [...EXPECTED_MERGED.feats, bookDefense] };
    const defenses = () => within(screen.getByRole('radiogroup', { name: 'Fighting Style' })).getAllByRole('radio', { name: /^Defense/ });
    const view = renderBuilder({ classId: FIGHTER.id }, data);
    expect(defenses()).toHaveLength(1);
    expect(within(defenses()[0]).getByText(`From ${GLOAMWOOD_TITLE}`)).toBeInTheDocument();
    view.unmount();
    renderBuilder({ classId: FIGHTER.id, fightingStyle: 'srd:feat:defense' }, data);
    expect(defenses()).toHaveLength(2);
    expect(defenses()[0]).toHaveAttribute('aria-checked', 'true');
  });

  it('lists one subclass per name for a class that chooses it at level 1', () => {
    const sub = WICKWRIGHT.subclasses[0];
    const early: ClassOption = {
      ...WICKWRIGHT,
      subclassLevel: 1,
      subclasses: [{ ...sub, id: 'srd:subclass:lamp-oath', name: 'Lamp Oath', source: undefined }, { ...sub, id: 'lib:gloam:subclass:lamp-oath', name: 'Lamp Oath' }],
    };
    renderBuilder({ classId: early.id }, { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes.filter((c) => c.id !== WICKWRIGHT.id), early] });
    const oaths = within(screen.getByRole('radiogroup', { name: 'Wickwright subclass' })).getAllByRole('radio', { name: /Lamp Oath/ });
    expect(oaths).toHaveLength(1);
    expect(within(oaths[0]).getByText(`From ${GLOAMWOOD_TITLE}`)).toBeInTheDocument();
  });

  it("leaves the background's Origin feat out of a species' feat choice, whichever book's it is (SRD 5.2.1 Feats: each feat once unless Repeatable)", () => {
    const lamplighter = byName(EXPECTED_MERGED.backgrounds, 'Lamplighter');
    const mothkin = byName(EXPECTED_MERGED.species, 'Mothkin');
    const bookAlert: FeatOption = { id: 'lib:gloam:feat:alert', name: 'Alert', category: 'origin', description: 'Invented: you wake at the first creak.', source: { ...lamplighter.source!, recordId: 'rec:gloam:feat:alert' } };
    const watch: BackgroundOption = { ...lamplighter, id: 'lib:gloam:background:night-watch', name: 'Night Watch', feat: 'Alert' };
    const wayfolk: SpeciesOption = { ...mothkin, id: 'lib:gloam:species:wayfolk', name: 'Wayfolk', traits: [{ name: 'Wayfarer', description: 'You gain an Origin feat of your choice.' }], lineages: undefined, lineageTrait: undefined };
    const data = { ...EXPECTED_MERGED, feats: [...EXPECTED_MERGED.feats, bookAlert], backgrounds: [...EXPECTED_MERGED.backgrounds, watch], species: [...EXPECTED_MERGED.species, wayfolk] };
    // The SRD filter lists the SRD's Alert: it is still the feat the background gives.
    renderBuilder({ step: 'species', classId: FIGHTER.id, backgroundId: watch.id, speciesId: wayfolk.id, sourceFilter: 'srd-5.2.1' }, data);
    const feats = within(screen.getByRole('radiogroup', { name: 'Origin feat' })).getAllByRole('radio').map((r) => r.textContent ?? '');
    expect(feats.filter((t) => t.includes('Alert'))).toEqual([]);
    expect(feats.some((t) => t.includes('Savage Attacker'))).toBe(true);
  });

  it("keeps a chosen Origin feat that doubles the background's on the species step, and says why it can't stay", () => {
    const lamplighter = byName(EXPECTED_MERGED.backgrounds, 'Lamplighter');
    const mothkin = byName(EXPECTED_MERGED.species, 'Mothkin');
    const bookAlert: FeatOption = { id: 'lib:gloam:feat:alert', name: 'Alert', category: 'origin', description: 'Invented: you wake at the first creak.', source: { ...lamplighter.source!, recordId: 'rec:gloam:feat:alert' } };
    const watch: BackgroundOption = { ...lamplighter, id: 'lib:gloam:background:night-watch', name: 'Night Watch', feat: 'Alert' };
    const wayfolk: SpeciesOption = { ...mothkin, id: 'lib:gloam:species:wayfolk', name: 'Wayfolk', traits: [{ name: 'Wayfarer', description: 'You gain an Origin feat of your choice.' }], lineages: undefined, lineageTrait: undefined };
    const data = { ...EXPECTED_MERGED, feats: [...EXPECTED_MERGED.feats, bookAlert], backgrounds: [...EXPECTED_MERGED.backgrounds, watch], species: [...EXPECTED_MERGED.species, wayfolk] };
    renderBuilder({ step: 'species', classId: FIGHTER.id, backgroundId: watch.id, speciesId: wayfolk.id, speciesFeat: 'srd:feat:alert' }, data);
    expect(radio('Origin feat', /^Alert/)).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('You already have Alert from your background; choose a different feat.')).toBeInTheDocument();
  });

  it("lists one spell per name: a book's accepted spell in place of the SRD's, and a chosen SRD spell beside it as known", () => {
    const CLERIC = byName(EXPECTED_MERGED.classes, 'Cleric');
    const entry = (id: string, name: string, extra: Partial<CompendiumEntry> = {}): SpellInfo =>
      spellInfo({ id, sourceId: 'srd-5.2.1', sourceName: 'SRD 5.2.1', kind: 'spell', name, summary: 'Evocation Cantrip (Cleric, Wizard)', text: 'Invented.', data: { level: 0, classes: ['Cleric', 'Wizard'] }, ...extra });
    const srdLight = entry('srd:spell:light', 'Light');
    const bookLight = entry('lib:gloam:950', 'Light', { sourceId: 'gloam', sourceName: GLOAMWOOD_TITLE, data: { level: 0, classes: ['Cleric', 'Wizard'], recordId: 'rec:gloam:spell:light', format: '2024' } });
    const spells = [srdLight, entry('srd:spell:sacred-flame', 'Sacred Flame'), entry('srd:spell:thaumaturgy', 'Thaumaturgy'), bookLight];
    const lights = () => within(screen.getByRole('list', { name: 'Cleric cantrips' })).getAllByRole('checkbox', { name: /^Light/ });
    const view = renderBuilder({ step: 'spells', classId: CLERIC.id }, EXPECTED_MERGED, spells);
    expect(lights()).toHaveLength(1);
    expect(lights()[0]).toHaveAccessibleName(new RegExp(`^Light\\s*From ${GLOAMWOOD_TITLE}`));
    view.unmount();
    renderBuilder({ step: 'spells', classId: CLERIC.id, cantrips: [srdLight.id] }, EXPECTED_MERGED, spells);
    const [srd, book] = lights();
    expect(srd).toBeChecked();
    expect(book).toBeDisabled();
    expect(book).toHaveAccessibleName(new RegExp(`^Light\\s*From ${GLOAMWOOD_TITLE}\\s*already known`));
    expect(srd).not.toHaveAccessibleName(/already known|From/);
  });

  it('shows a cantrip the species already gives as known on the class list', () => {
    const CLERIC = byName(EXPECTED_MERGED.classes, 'Cleric');
    const mothkin = byName(EXPECTED_MERGED.species, 'Mothkin');
    const lampborn: SpeciesOption = { ...mothkin, id: 'lib:gloam:species:lampborn', name: 'Lampborn', traits: [{ name: 'Wick Whisper', description: 'You know the Thaumaturgy cantrip.' }], lineages: undefined, lineageTrait: undefined };
    const entry = (id: string, name: string): SpellInfo =>
      spellInfo({ id, sourceId: 'srd-5.2.1', sourceName: 'SRD 5.2.1', kind: 'spell', name, summary: 'Evocation Cantrip (Cleric)', text: 'Invented.', data: { level: 0, classes: ['Cleric'] } });
    const spells = [entry('srd:spell:light', 'Light'), entry('srd:spell:sacred-flame', 'Sacred Flame'), entry('srd:spell:thaumaturgy', 'Thaumaturgy')];
    renderBuilder({ step: 'spells', classId: CLERIC.id, speciesId: lampborn.id }, { ...EXPECTED_MERGED, species: [...EXPECTED_MERGED.species, lampborn] }, spells);
    const thaumaturgy = within(screen.getByRole('list', { name: 'Cleric cantrips' })).getByRole('checkbox', { name: /^Thaumaturgy/ });
    expect(thaumaturgy).toBeDisabled();
    expect(thaumaturgy).toHaveAccessibleName(/already known/);
  });

  it("lets Magic Initiate's level 1 spell be one the class keeps prepared, while the class list shows it as known", () => {
    const CLERIC = byName(EXPECTED_MERGED.classes, 'Cleric');
    const ferry = byName(EXPECTED_MERGED.backgrounds, 'Ferry Hand');
    const vowed: ClassOption = { ...CLERIC, id: 'srd:class:vowed-cleric', features: [...CLERIC.features, { level: 1, name: 'Lantern Vow', description: 'You always have the Bless spell prepared.' }] };
    const entry = (id: string, name: string, level: number): SpellInfo =>
      spellInfo({ id, sourceId: 'srd-5.2.1', sourceName: 'SRD 5.2.1', kind: 'spell', name, summary: level ? `Level ${level} Enchantment (Cleric)` : 'Evocation Cantrip (Cleric)', text: 'Invented.', data: { level, classes: ['Cleric'] } });
    const spells = [entry('srd:spell:light', 'Light', 0), entry('srd:spell:sacred-flame', 'Sacred Flame', 0), entry('srd:spell:bless', 'Bless', 1), entry('srd:spell:heal-light', 'Healing Word', 1)];
    renderBuilder(
      { step: 'spells', classId: vowed.id, backgroundId: ferry.id, backgroundFeat: 'srd:feat:magic-initiate', backgroundFeatList: 'Cleric' },
      { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, vowed] },
      spells,
    );
    const bless = (list: string) => within(screen.getByRole('list', { name: list })).getByRole('checkbox', { name: /^Bless/ });
    expect(bless('Prepared level 1 spells')).toBeDisabled();
    expect(bless('Cleric level 1 spell')).toBeEnabled();
  });

  it('narrows the options to one source, and "Let the DM decide" picks among what it shows', async () => {
    const user = userEvent.setup();
    renderBuilder();
    const classes = () => within(screen.getByRole('radiogroup', { name: 'Class' })).getAllByRole('radio').map((r) => r.textContent ?? '');
    expect(classes()).toHaveLength(3);
    await user.click(within(screen.getByRole('radiogroup', { name: 'Show options from' })).getByRole('radio', { name: /Gloamwood/ }));
    expect(classes()).toEqual([expect.stringContaining('Wickwright')]);
    await user.click(screen.getByRole('button', { name: 'Let the DM decide' }));
    expect(radio('Class', /Wickwright/)).toHaveAttribute('aria-checked', 'true');
    // The SRD's classes, and the one already chosen (a filter never hides the player's pick).
    await user.click(within(screen.getByRole('radiogroup', { name: 'Show options from' })).getByRole('radio', { name: 'SRD' }));
    expect(classes()).toEqual([expect.stringContaining('Cleric'), expect.stringContaining('Fighter'), expect.stringContaining('Wickwright')]);
  });

  it('says when more of a book’s options wait for review, linking to the book page', async () => {
    mocks.pending = [{ sourceId: 'gloam', title: GLOAMWOOD_TITLE, kind: 'class', count: 3 }];
    renderBuilder();
    const link = await screen.findByRole('link', { name: `3 more classes from “${GLOAMWOOD_TITLE}” are waiting for your review in the Library.` });
    expect(link).toHaveAttribute('href', '/library/source/gloam?k=class');
  });

  it("lets an older background raise any three abilities and choose its Origin feat", async () => {
    const user = userEvent.setup();
    const ferry = byName(EXPECTED_MERGED.backgrounds, 'Ferry Hand');
    renderBuilder({ step: 'background', classId: FIGHTER.id, fightingStyle: 'Defense' });
    await user.click(radio('Background', /Ferry Hand/));
    expect(within(radio('Background', /Ferry Hand/)).getByText('Any three abilities')).toBeInTheDocument();
    expect(screen.getByText(/doesn't grant an Origin feat, so you choose one/, { selector: 'li' })).toBeInTheDocument();
    expect(screen.getByText("Background feature: Ferryman's Right")).toBeInTheDocument();
    await user.click(radio('Origin feat', /Moth's Grace/));
    expect(radio('Origin feat', /Moth's Grace/)).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('button', { name: /Next: Species/ }));
    await user.click(screen.getByRole('button', { name: /Next: Ability scores/ }));
    await user.click(within(screen.getByRole('radiogroup', { name: 'Increase pattern' })).getByRole('radio', { name: '+1 to all three' }));
    const chips = within(screen.getByRole('group', { name: 'Abilities that get +1' }));
    expect(chips.getAllByRole('button')).toHaveLength(6);
    for (const name of ['Strength', 'Constitution', 'Wisdom']) await user.click(chips.getByRole('button', { name }));
    expect(chips.getByRole('button', { name: /^Dexterity/ })).toBeDisabled();
    expect(screen.getByText('+1 to three abilities (3/3)')).toBeInTheDocument();
    expect(ferry.abilityChoice).toBe('any');
  });

  it('asks for the subclass of a class that chooses it at level 1', async () => {
    const user = userEvent.setup();
    const order = WICKWRIGHT.subclasses[0];
    const lampwright: ClassOption = { ...WICKWRIGHT, id: 'lib:gloam:class:lampwright', name: 'Lampwright', subclassLevel: 1, subclasses: [{ ...order, features: order.features.map((f) => ({ ...f, level: 1 })) }] };
    renderBuilder({}, { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, lampwright] });
    await user.click(radio('Class', /Lampwright/));
    expect(screen.getByText('Lampwright chooses its subclass at level 1.')).toBeInTheDocument();
    await user.click(radio('Lampwright subclass', /Order of the Long Wick/));
    expect(radio('Lampwright subclass', /Order of the Long Wick/)).toHaveAttribute('aria-checked', 'true');
  });

  it('lists the subclasses a class shares (merge.ts) after its own, for a class that chooses at level 1', async () => {
    const user = userEvent.setup();
    const [order] = WICKWRIGHT.subclasses;
    const atOne = (s: typeof order, id: string, name: string) => ({ ...s, id, name, features: s.features.map((f) => ({ ...f, level: 1 })) });
    const lampwright: ClassOption = {
      ...WICKWRIGHT,
      id: 'lib:gloam:class:lampwright',
      name: 'Lampwright',
      subclassLevel: 1,
      subclasses: [atOne(order, order.id, order.name)],
      sharedSubclasses: [atOne(order, 'srd:subclass:lamp-oath', 'Lamp Oath')],
    };
    renderBuilder({}, { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, lampwright] });
    await user.click(radio('Class', /Lampwright/));
    const names = within(screen.getByRole('radiogroup', { name: 'Lampwright subclass' })).getAllByRole('radio');
    expect(names).toHaveLength(2);
    expect(names[1]).toHaveAccessibleName(/^Lamp Oath/);
    await user.click(names[1]);
    expect(radio('Lampwright subclass', /Lamp Oath/)).toHaveAttribute('aria-checked', 'true');
  });

  it("B4: shows a book's Fighting Style that shares an SRD feat's name as its own card, and checks only the one chosen", async () => {
    const user = userEvent.setup();
    const srdGwf = EXPECTED_MERGED.feats.find((f) => f.id === 'srd:feat:great-weapon-fighting');
    const bookGwf: FeatOption = {
      id: 'lib:gloam:feat:great-weapon-fighting',
      name: 'Great Weapon Fighting',
      category: 'fighting-style',
      description: 'Invented: once per turn, when you miss with a Heavy weapon, you can reroll the attack roll.',
      source: { sourceId: 'gloam', title: GLOAMWOOD_TITLE, recordId: 'rec:gloam:feat:great-weapon-fighting', format: '2014', adaptations: [] },
    };
    expect(srdGwf).toBeDefined();
    renderBuilder({ classId: FIGHTER.id }, { ...EXPECTED_MERGED, feats: [...EXPECTED_MERGED.feats, bookGwf] });
    const cards = () => within(screen.getByRole('radiogroup', { name: 'Fighting Style' })).getAllByRole('radio', { name: /Great Weapon Fighting/ });
    expect(cards()).toHaveLength(2);
    expect(within(cards()[0]).getByText('SRD')).toBeInTheDocument();
    expect(within(cards()[1]).getByText(`From ${GLOAMWOOD_TITLE}`)).toBeInTheDocument();
    await user.click(cards()[1]);
    expect(cards().map((c) => c.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    await user.click(cards()[0]);
    expect(cards().map((c) => c.getAttribute('aria-checked'))).toEqual(['true', 'false']);
  });

  it('says when a picked option came from a book that is switched off or removed', () => {
    renderBuilder({ classId: 'lib:gone:class:lampwright' });
    expect(screen.getByText("The class you picked came from a book that's switched off or removed. Switch it on in the Library, or pick another.")).toBeInTheDocument();
  });

  it("names the options from the player's books on the Review step, with the older-edition notes", () => {
    const bramblefolk = byName(EXPECTED_MERGED.species, 'Bramblefolk');
    const ferry = byName(EXPECTED_MERGED.backgrounds, 'Ferry Hand');
    renderBuilder({ step: 'review', classId: FIGHTER.id, fightingStyle: 'Defense', backgroundId: ferry.id, speciesId: bramblefolk.id });
    expect(
      screen.getByText('From your books: Bramblefolk (species), Ferry Hand (background). Their text stays on this device; saves keep only the names.'),
    ).toBeInTheDocument();
    const box = screen.getByText(/aren't used. In the 2024 rules your background sets your ability scores/, { selector: 'li' }).closest('div') as HTMLElement;
    expect(within(box).getByText('Older edition')).toBeInTheDocument();
    expect(within(box).getByText(/Ferry Hand doesn't list ability scores, so you choose any three to increase/)).toBeInTheDocument();
  });

  it('shows no book badges, filter or provenance for SRD-only data', () => {
    const srdOnly: BuilderData = {
      ...EXPECTED_MERGED,
      classes: EXPECTED_MERGED.classes.filter((c) => !c.source).map((c) => ({ ...c, subclasses: c.subclasses.filter((s) => !s.source) })),
      species: [],
      backgrounds: [],
      feats: EXPECTED_MERGED.feats.filter((f) => !f.source),
      equipment: EXPECTED_MERGED.equipment.filter((e) => !e.source),
    };
    renderBuilder({}, srdOnly);
    expect(screen.queryByRole('radiogroup', { name: 'Show options from' })).toBeNull();
    expect(screen.queryByText(/^From /)).toBeNull();
    expect(screen.queryByText('SRD')).toBeNull();
  });
});
