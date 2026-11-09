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
import type { BuilderData, ClassOption, FeatOption, StructuredKind } from '@/types';
import { resetFakeGame } from '@/ui/builder/testing/fakeGameStore';
import { autoCleanup, renderRoute } from '@/ui/shell/testUtils';
import { CharacterBuilder } from './CharacterBuilder';
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

function renderBuilder(draft: Partial<BuilderDraft> = {}, data: BuilderData = EXPECTED_MERGED) {
  writeDraft(campaign.id, { ...emptyDraft(), ...draft });
  return renderRoute(<CharacterBuilder campaign={campaign} data={data} spells={NO_SPELLS} onSave={async () => undefined} />);
}
const radio = (group: string, name: RegExp | string) => within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name });

autoCleanup();
beforeEach(() => {
  mocks.pending = [];
  sessionStorage.clear();
  resetFakeGame({ campaign, character: null });
});

describe('CharacterBuilder with imported options', () => {
  it('badges imported options with their book, and an SRD option only when an import shares its name', () => {
    const importedFighter: ClassOption = { ...WICKWRIGHT, id: 'lib:gloam:class:fighter', name: 'Fighter', subclasses: [] };
    renderBuilder({}, { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, importedFighter] });
    expect(within(radio('Class', /Wickwright/)).getByText(`From ${GLOAMWOOD_TITLE}`)).toBeInTheDocument();
    const fighters = within(screen.getByRole('radiogroup', { name: 'Class' })).getAllByRole('radio', { name: /Fighter/ });
    expect(fighters).toHaveLength(2);
    expect(within(fighters[0]).getByText('SRD')).toBeInTheDocument();
    expect(within(fighters[1]).getByText(`From ${GLOAMWOOD_TITLE}`)).toBeInTheDocument();
    expect(within(radio('Class', /Cleric/)).queryByText('SRD')).toBeNull();
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
