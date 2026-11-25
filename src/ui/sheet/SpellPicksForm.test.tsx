/**
 * The sheet's spell choices form on the real engine, the SRD's class tables (SRD_BUILDER_DATA) and its spells
 * (public/srd/compendium.json), with a fake game store: a level's picks, a swap, skipping, a Long Rest's change, and
 * what it says when the data isn't there.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import compendiumRaw from '../../../public/srd/compendium.json?raw';
import { nameKey } from '@/lib/id';
import { useGame } from '@/state/gameStore';
import { sampleCampaign, sampleCharacter } from '@/test/fixtures';
import { SRD_BUILDER_DATA } from '@/test/structuredFixtures';
import type { BuilderData, Character, ClassLevel, CompendiumEntry, KnownSpell, SpellPicksOwed } from '@/types';
import { installDialogPolyfill, resetFakeGame } from '@/ui/builder/testing/fakeGameStore';
import { autoCleanup } from '@/ui/shell/testUtils';
import { SpellPicksDialog, type SpellPicksTarget } from './SpellPicksForm';

const SPELLS = (JSON.parse(compendiumRaw) as CompendiumEntry[]).filter((e) => e.kind === 'spell');
const mocks = vi.hoisted(() => ({ data: null as BuilderData | null, spells: [] as CompendiumEntry[], indexError: null as string | null }));

vi.mock('@/state/gameStore', async () => (await import('@/ui/builder/testing/fakeGameStore')).fakeGameStoreModule());
vi.mock('@/data', () => {
  const index = {
    get: (id: string) => mocks.spells.find((s) => s.id === id),
    findByName: (name: string) => mocks.spells.find((s) => s.name.toLowerCase() === name.toLowerCase()),
    list: (q: { kind?: string }) => mocks.spells.filter((s) => !q.kind || s.kind === q.kind),
  };
  return {
    useBuilderData: () => ({ data: mocks.data, error: null, loading: false }),
    useRulesIndexState: () => (mocks.indexError ? { index: null, loading: false, error: mocks.indexError } : { index, loading: false, error: null }),
    useRulesIndex: () => index,
    getRulesIndex: async () => index,
  };
});

const notices = () => vi.mocked(useGame.getState().queueDmNotice).mock.calls.map(([text]) => text);
const sheet = () => useGame.getState().character as Character;
const spellOf = (name: string) => sheet().spellcasting?.spells.find((s) => s.name === name);

const entry = (name: string, level: number): ClassLevel => {
  const o = SRD_BUILDER_DATA.classes.find((c) => c.name === name)!;
  return { classId: o.id, name: o.name, level, hitDie: o.hitDie, casterType: o.casterType, ...(o.spellcastingAbility ? { spellcastingAbility: o.spellcastingAbility } : {}) };
};
const known = (name: string, source: string, extra: Partial<KnownSpell> = {}): KnownSpell => {
  const e = SPELLS.find((s) => nameKey(s.name) === nameKey(name))!;
  return { id: e.id, name: e.name, level: Number(e.data?.level), prepared: true, source, ...extra };
};
const fill = (className: string, n: number, level: number): KnownSpell[] =>
  Array.from({ length: n }, (_, i) => ({ id: `fill-${className}-${level}-${i}`, name: `${className} spell ${level}-${i}`, level, prepared: true, source: className }));
const hero = (classes: ClassLevel[], spells: KnownSpell[], picks: SpellPicksOwed[] = []): Character =>
  sampleCharacter({ classes, features: [], spellcasting: { ability: 'cha', slots: {}, spells, concentratingOn: null, spellPicks: picks } });

/** The sample Wizard 3 (Mira Voss) after gaining Wizard 4 in the level-up dialog, its choices open. */
const wizard4 = (): Character => {
  const base = sampleCharacter();
  return { ...base, classes: base.classes.map((cl) => ({ ...cl, level: 4 })), spellcasting: { ...base.spellcasting!, spellPicks: [{ classId: 'srd:class:wizard' }] } };
};

function show(target: SpellPicksTarget, onClose = vi.fn()) {
  render(<SpellPicksDialog target={target} onClose={onClose} />);
  return onClose;
}
const group = (name: RegExp) => within(screen.getByRole('group', { name }));
const status = () => screen.getByText(/^Still to choose|^Nothing left to choose|^Choose what to give up/);

beforeAll(() => installDialogPolyfill());
autoCleanup();
beforeEach(() => {
  mocks.data = SRD_BUILDER_DATA;
  mocks.spells = SPELLS;
  mocks.indexError = null;
});

describe("the spell choices form: a level's picks", () => {
  it("chooses a Wizard 4's cantrip, spellbook and prepared spells on the sample hero (srd:rule:wizard-spellcasting)", async () => {
    const user = userEvent.setup();
    resetFakeGame({ campaign: sampleCampaign(), character: wizard4() });
    const onClose = show({ mode: 'level', classId: 'srd:class:wizard' });
    expect(screen.getByRole('dialog', { name: 'Choose spells' })).toBeInTheDocument();
    expect(screen.getByText('Spells of level 1–2, as your Wizard slots allow. Your DM is told what you choose.')).toBeInTheDocument();
    expect(status()).toHaveTextContent('Still to choose: 1 cantrip, 6 for your book, 2 to prepare');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

    // Cantrips: the Wizard list, the ones held shown as known (Prestidigitation is the High Elf's: still the same name).
    const cantrips = group(/^Cantrips Choose up to 1/);
    for (const held of ['Fire Bolt', 'Light', 'Mage Hand', 'Prestidigitation']) {
      expect(cantrips.getByRole('checkbox', { name: new RegExp(`^${held}`) })).toBeDisabled();
      expect(cantrips.getByRole('checkbox', { name: new RegExp(`^${held}`) })).toHaveAccessibleName(/already known/);
    }
    await user.click(cantrips.getByRole('checkbox', { name: /^Ray of Frost/ }));
    expect(cantrips.getByRole('checkbox', { name: /^Chill Touch/ })).toHaveAccessibleDescription('Limit reached: uncheck one to change.');

    // "Whenever you gain a Wizard level after 1, add two Wizard spells of your choice to your spellbook. Each of these
    // spells must be of a level for which you have spell slots": levels 1–2, the newest open.
    const book = group(/^Spellbook Choose up to 6/);
    expect(book.queryByRole('checkbox', { name: /^Fireball/ })).toBeNull();
    expect(book.getByRole('checkbox', { name: /^Misty Step/ })).toHaveAccessibleName(/already known/);
    await user.click(book.getByRole('checkbox', { name: /^Web/ }));
    await user.click(book.getByRole('checkbox', { name: /^Hold Person/ }));

    // Prepared spells come from the book: its unprepared Sleep and the new ones.
    const prepare = group(/^Prepare from your spellbook Choose up to 2/);
    expect(prepare.getAllByRole('checkbox').map((c) => c.closest('label')?.querySelector('span')?.textContent)).toEqual(['Sleep', 'Hold Person', 'Web']);
    await user.click(prepare.getByRole('checkbox', { name: /^Web/ }));
    await user.click(prepare.getByRole('checkbox', { name: /^Sleep/ }));
    expect(status()).toHaveTextContent('Still to choose: 4 for your book');

    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(notices()).toEqual(['Player chose spells for Wizard 4: cantrip Ray of Frost; spellbook Web, Hold Person; prepared Web, Sleep; still to choose: 4 spellbook spells']);
    expect(spellOf('Hold Person')).toMatchObject({ source: 'Wizard', prepared: false });
    expect(spellOf('Sleep')?.prepared).toBe(true);
    expect(sheet().spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:wizard' }]);
    expect(onClose).toHaveBeenCalled();
  });

  it('takes a new book spell out of the prepared list when it leaves the book', async () => {
    const user = userEvent.setup();
    resetFakeGame({ campaign: sampleCampaign(), character: wizard4() });
    show({ mode: 'level', classId: 'srd:class:wizard' });
    await user.click(group(/^Spellbook/).getByRole('checkbox', { name: /^Web/ }));
    await user.click(group(/^Prepare from your spellbook/).getByRole('checkbox', { name: /^Web/ }));
    await user.click(group(/^Spellbook/).getByRole('checkbox', { name: /^Web/ }));
    expect(group(/^Prepare from your spellbook/).queryByRole('checkbox', { name: /^Web/ })).toBeNull();
    expect(status()).toHaveTextContent('Still to choose: 1 cantrip, 6 for your book, 2 to prepare');
  });

  it("replaces a Sorcerer's spell on gaining a level, the give-up adding one to the list (srd:rule:sorcerer-spellcasting)", async () => {
    const user = userEvent.setup();
    // A Sorcerer 5 at its table (5 cantrips, 9 prepared, Burning Hands among them) at Sorcerer 6.
    const sorcerer = hero(
      [entry('Sorcerer', 6)],
      [known('Fire Bolt', 'Sorcerer'), ...fill('Sorcerer', 4, 0), known('Burning Hands', 'Sorcerer'), ...fill('Sorcerer', 8, 1)],
      [{ classId: 'srd:class:sorcerer', replaceSpell: true, replaceCantrip: true }],
    );
    resetFakeGame({ campaign: sampleCampaign(), character: sorcerer });
    show({ mode: 'level', classId: 'srd:class:sorcerer' });
    // No cantrip is owed, but one may be replaced: the list waits for the one given up.
    expect(screen.queryByRole('group', { name: /^Cantrips/ })).toBeNull();
    expect(screen.getByLabelText('Give up one cantrip (optional)')).toBeInTheDocument();
    const giveUp = screen.getByLabelText('Give up one spell (optional)');
    expect(giveUp).toHaveAccessibleDescription("Replacing ends with this level's choices.");
    expect(group(/^Prepared spells Choose up to 1/).getByRole('checkbox', { name: /^Haste/ })).toBeEnabled();
    await user.selectOptions(giveUp, 'Burning Hands (level 1)');
    expect(status()).toHaveTextContent('Still to choose: a replacement for Burning Hands, 1 prepared spell');
    const prepared = group(/^Prepared spells Choose up to 2/);
    await user.click(prepared.getByRole('checkbox', { name: /^Haste/ }));
    await user.click(prepared.getByRole('checkbox', { name: /^Fireball/ }));
    expect(status()).toHaveTextContent('Nothing left to choose');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(notices()).toEqual(['Player chose spells for Sorcerer 6: prepared Haste; replaced Burning Hands with Fireball']);
    expect(spellOf('Burning Hands')).toBeUndefined();
    expect(sheet().spellcasting?.spellPicks).toBeUndefined();
  });

  it('skips the choices: the record closes and the DM hears what was not chosen', async () => {
    const user = userEvent.setup();
    resetFakeGame({ campaign: sampleCampaign(), character: wizard4() });
    const onClose = show({ mode: 'level', classId: 'srd:class:wizard' });
    await user.click(screen.getByRole('button', { name: 'Skip these choices' }));
    expect(notices()).toEqual(['Player skipped their spell choices for Wizard 4 (not chosen: 1 cantrip, 6 spellbook spells and 2 prepared spells)']);
    expect(sheet().spellcasting?.spellPicks).toBeUndefined();
    expect(sheet().spellcasting?.spells).toEqual(wizard4().spellcasting?.spells);
    expect(onClose).toHaveBeenCalled();
  });

  it("reads a spell in the form itself, and Cancel changes nothing", async () => {
    const user = userEvent.setup();
    resetFakeGame({ campaign: sampleCampaign(), character: wizard4() });
    const onClose = show({ mode: 'level', classId: 'srd:class:wizard' });
    await user.click(screen.getByRole('button', { name: 'About Ray of Frost' }));
    // No dialog on top of the dialog: the text replaces the lists until Back.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const reader = screen.getByRole('region', { name: 'Ray of Frost' });
    expect(within(reader).getByText(/Cold damage/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /^Cantrips/ })).toBeNull();
    await user.click(within(reader).getByRole('button', { name: 'Back to the spells' }));
    expect(screen.getByRole('group', { name: /^Cantrips/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(notices()).toEqual([]);
    expect(useGame.getState().updateCharacter).not.toHaveBeenCalled();
  });

  it("explains a multiclass hero's cap and a Bard's Magical Secrets (srd:rule:multiclassing-class-features-spellcasting, srd:rule:bard-magical-secrets)", () => {
    // A Wizard 3 / Cleric 1: level 2 slots, but Cleric spells of level 1 only.
    const multi = hero([entry('Wizard', 3), entry('Cleric', 1)], fill('Wizard', 3, 0), [{ classId: 'srd:class:cleric' }]);
    resetFakeGame({ campaign: sampleCampaign(), character: multi });
    show({ mode: 'level', classId: 'srd:class:cleric' });
    expect(screen.getByText("Cleric spells of level 1 — as a Cleric 1; your other classes' slots don't raise this")).toBeInTheDocument();
    expect(group(/^Prepared spells Choose up to 4/).queryByRole('checkbox', { name: /^Spiritual Weapon/ })).toBeNull();
  });

  it("notes Magical Secrets' other lists for a Bard 10 (srd:rule:bard-magical-secrets)", () => {
    // Bard 9 → 10: the Prepared Spells column goes from 14 to 15.
    const bard = hero([entry('Bard', 10)], [...fill('Bard', 3, 0), ...fill('Bard', 14, 1)], [{ classId: 'srd:class:bard', replaceSpell: true }]);
    resetFakeGame({ campaign: sampleCampaign(), character: bard });
    show({ mode: 'level', classId: 'srd:class:bard' });
    expect(screen.getByText("Magical Secrets: spells from the Cleric, Druid and Wizard lists aren't listed here; choose those with your DM.")).toBeInTheDocument();
  });
});

describe('the spell choices form: a Long Rest change', () => {
  it("changes a Cleric's prepared spells one for one (srd:rule:cleric-spellcasting)", async () => {
    const user = userEvent.setup();
    // "Whenever you finish a Long Rest, you can change your list of prepared spells, replacing any of the spells there
    // with other Cleric spells for which you have spell slots."
    const cleric = hero([entry('Cleric', 3)], [...fill('Cleric', 3, 0), known('Bless', 'Cleric'), known('Guiding Bolt', 'Cleric'), ...fill('Cleric', 4, 1)]);
    resetFakeGame({ campaign: sampleCampaign(), character: cleric });
    const onClose = show({ mode: 'rest', classId: 'srd:class:cleric' });
    expect(screen.getByRole('dialog', { name: 'Change prepared spells' })).toBeInTheDocument();
    expect(screen.getByText('Clerics change these after a Long Rest. Your DM is told.')).toBeInTheDocument();
    expect(status()).toHaveTextContent('Choose what to give up, then its replacement');
    await user.click(group(/^Prepared spells to give up/).getByRole('checkbox', { name: /^Bless/ }));
    expect(status()).toHaveTextContent('Still to choose: 1 replacement');
    const replacements = group(/^Replacements Choose up to 1/);
    // The Cleric's own list up to its slots (Cleric 3: level 2); a spell the sheet holds isn't offered again.
    expect(replacements.queryByRole('checkbox', { name: /^Revivify/ })).toBeNull();
    expect(replacements.getByRole('checkbox', { name: /^Guiding Bolt/ })).toBeDisabled();
    await user.click(replacements.getByRole('checkbox', { name: /^Sanctuary/ }));
    expect(status()).toHaveTextContent('Nothing left to choose');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(notices()).toEqual(['Player changed their Cleric prepared spells (allowed after a Long Rest): Bless → Sanctuary']);
    expect(spellOf('Bless')).toBeUndefined();
    expect(spellOf('Sanctuary')).toMatchObject({ source: 'Cleric', prepared: true });
    expect(onClose).toHaveBeenCalled();
  });

  it("offers a Wizard its cantrip, its prepared spells staying with the checkboxes (srd:rule:wizard-spellcasting)", async () => {
    const user = userEvent.setup();
    resetFakeGame({ campaign: sampleCampaign(), character: sampleCharacter() });
    show({ mode: 'rest', classId: 'srd:class:wizard' });
    expect(screen.getByText('Wizards replace one cantrip after a Long Rest. Your DM is told.')).toBeInTheDocument();
    expect(screen.getByText("Your spellbook's prepared spells change with the Prepared checkboxes on the Spells tab.")).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /give up/ })).toBeNull();
    await user.selectOptions(screen.getByLabelText('Cantrip to replace'), 'Light');
    await user.click(group(/^Replacement cantrip/).getByRole('checkbox', { name: /^Ray of Frost/ }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(notices()).toEqual(['Player changed their Wizard cantrips (allowed after a Long Rest): Light → Ray of Frost']);
  });
});

describe('the spell choices form without its data', () => {
  it("says so when the spell lists aren't available, and keeps the choices open", async () => {
    const user = userEvent.setup();
    mocks.indexError = 'the rules index failed';
    resetFakeGame({ campaign: sampleCampaign(), character: wizard4() });
    const onClose = show({ mode: 'level', classId: 'srd:class:wizard' });
    expect(screen.getByText("The spell lists aren't available right now (the rules index failed). Your DM can add spells; your choices stay open.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip these choices' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(sheet().spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:wizard' }]);
  });

  it("says so when the class's data isn't on this device", () => {
    mocks.data = { ...SRD_BUILDER_DATA, classes: SRD_BUILDER_DATA.classes.filter((c) => c.name !== 'Wizard') };
    resetFakeGame({ campaign: sampleCampaign(), character: wizard4() });
    show({ mode: 'level', classId: 'srd:class:wizard' });
    expect(screen.getByText("Wizard's details aren't on this device, so its spells can't be listed here. Your DM can add spells; your choices stay open.")).toBeInTheDocument();
  });
});
