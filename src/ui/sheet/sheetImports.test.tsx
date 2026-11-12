/**
 * The sheet with content from the player's books (spec §6.4, §6.6, §7.5, §8.3): book badges, the
 * missing-text notice on a device without the book, the Features note, attunement and bonuses on items
 * (the real engine: SRD 5.2.1 "Attunement"), linking added items, and spells from a book that isn't here.
 * Content is the invented Gloamwood fixture.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { savingThrowModifier } from '@/engine';
import { inventoryFromOption } from '@/data/options/resolve';
import { importedPlaceholder } from '@/lib/importedContent';
import { useGame } from '@/state/gameStore';
import { deleteLibrarySource, saveLibrarySource } from '@/storage';
import { sampleCampaign, sampleCharacter } from '@/test/fixtures';
import { EXPECTED_MERGED, GLOAMWOOD_TITLE, gloamwoodEntryId, gloamwoodSource, importedRef, TEXT } from '@/test/structuredFixtures';
import type { Character, CompendiumEntry, EquipmentOption, Feature, InventoryItem } from '@/types';
import { installDialogPolyfill, resetFakeGame } from '@/ui/builder/testing/fakeGameStore';
import { autoCleanup } from '@/ui/shell/testUtils';
import { CharacterSheet } from './CharacterSheet';
import { textMissing } from './FeatureItem';

const mocks = vi.hoisted(() => ({ entries: [] as CompendiumEntry[] }));

vi.mock('@/images', () => import('@/ui/play/testing/imagesMock'));
vi.mock('@/state/gameStore', async () => (await import('@/ui/builder/testing/fakeGameStore')).fakeGameStoreModule());
vi.mock('@/data', async () => {
  const { EXPECTED_MERGED: data } = await import('@/test/structuredFixtures');
  const key = (s: string) => s.toLowerCase();
  const index = {
    get: (id: string) => mocks.entries.find((e) => e.id === id),
    findByName: (name: string, opts: { kind?: string } = {}) => mocks.entries.find((e) => key(e.name) === key(name) && (!opts.kind || e.kind === opts.kind)),
  };
  return {
    useBuilderData: () => ({ data, error: null, loading: false }),
    loadBuilderData: async () => data,
    useRulesIndex: () => index,
    getRulesIndex: async () => index,
    countUnreviewedOptions: async () => [],
  };
});

const option = (name: string): EquipmentOption => EXPECTED_MERGED.equipment.find((o) => o.name === name) as EquipmentOption;
const LANTERN: CompendiumEntry = {
  id: gloamwoodEntryId('Lantern of Hollow Light'),
  sourceId: 'gloam',
  sourceName: GLOAMWOOD_TITLE,
  kind: 'magic-item',
  name: 'Lantern of Hollow Light',
  text: 'This lantern burns without oil.',
  data: { recordId: 'rec:gloam:magic-item:lantern-of-hollow-light', category: 'wondrous-item', rarity: 'uncommon', attunement: 'by a Wizard', charges: 3 },
};
const CLOAK_ENTRY: CompendiumEntry = {
  id: option('Mothsilk Cloak').id,
  sourceId: 'gloam',
  sourceName: GLOAMWOOD_TITLE,
  kind: 'magic-item',
  name: 'Mothsilk Cloak',
  text: 'Woven from the silk of a thousand moths.',
  data: { recordId: 'rec:gloam:magic-item:mothsilk-cloak', category: 'wondrous-item', rarity: 'uncommon', attunement: true, bonuses: { ac: 1, savingThrows: 1 } },
};

function Harness() {
  const character = useGame((s) => s.character);
  return character ? <CharacterSheet character={character} editable variant="full" /> : null;
}
const sheet = () => useGame.getState().character as Character;
const item = (patch: Partial<InventoryItem> & Pick<InventoryItem, 'name'>): InventoryItem => ({ id: `it-${patch.name}`, quantity: 1, ...patch });
function start(extra: Partial<Character> = {}, restore = vi.fn(async () => ({ restored: 0, differs: 0, missing: [] }))) {
  const base = sampleCharacter();
  resetFakeGame({ campaign: sampleCampaign(), character: { ...base, ...extra }, restoreImportedText: restore });
  return restore;
}
const emberWard = (description: string, redacted = false): Feature => ({
  id: 'f-ward',
  name: 'Ember Ward',
  source: 'subclass',
  sourceName: 'Ember Warden 3',
  description,
  ref: { ...importedRef(), ...(redacted ? { redacted: true as const } : {}) },
});

beforeAll(() => installDialogPolyfill());
autoCleanup();
beforeEach(() => {
  mocks.entries = [LANTERN, CLOAK_ENTRY];
  try {
    localStorage.clear();
  } catch {
    // no storage in this environment
  }
});

describe('features from the player’s books', () => {
  it('shows the book badge and the text when this device has it', async () => {
    const user = userEvent.setup();
    start({ features: [emberWard(TEXT.emberWard.join('\n\n'))] });
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Features/ }));
    const row = screen.getByText('Ember Ward').closest('li') as HTMLElement;
    expect(within(row).getByText(`From ${GLOAMWOOD_TITLE}`)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: /Ember Ward/ }));
    expect(within(row).getByText(/banked heat/)).toBeInTheDocument();
  });

  it('says where the text went on a device without the book, with Open the Library and Look again', async () => {
    const user = userEvent.setup();
    const restore = start({ features: [emberWard(importedPlaceholder(GLOAMWOOD_TITLE), true)] });
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Features/ }));
    await user.click(screen.getByRole('button', { name: /Ember Ward/ }));
    expect(screen.getByText(`This text is from “${GLOAMWOOD_TITLE}”, which isn't in this device's Library. Import the book here and it comes back.`)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the Library' })).toHaveAttribute('href', '#/library');
    await user.click(screen.getByRole('button', { name: 'Look again' }));
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('P3: a ruling stored over a pulled placeholder before the fix (ref.redacted still set) shows as written, not as missing', async () => {
    const user = userEvent.setup();
    const RULING = 'DM ruling: once per turn, add 1d4 fire damage.';
    start({ features: [emberWard(RULING, true)] });
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Features/ }));
    await user.click(screen.getByRole('button', { name: /Ember Ward/ }));
    expect(screen.getByText(RULING)).toBeInTheDocument();
    expect(screen.queryByText(/isn't in this device's Library/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Look again' })).toBeNull();
    expect(textMissing({ description: RULING, ref: { ...importedRef(), redacted: true } })).toBe(false);
    expect(textMissing({ description: importedPlaceholder(GLOAMWOOD_TITLE), ref: { ...importedRef(), redacted: true } })).toBe(true);
  });

  it('notes once that features come from the player’s books, until dismissed', async () => {
    const user = userEvent.setup();
    start({ features: [emberWard(TEXT.emberWard.join('\n\n')), { id: 'f2', name: 'Kindled Strikes', source: 'subclass', description: 'x', ref: importedRef({ part: 'Kindled Strikes' }) }] });
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Features/ }));
    expect(screen.getByText('2 features come from your books. Their text stays on this device; saves keep the names.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss this note' }));
    expect(screen.queryByText(/come from your books/)).toBeNull();
  });

  it('has no note or badge for an SRD-only hero', async () => {
    const user = userEvent.setup();
    start();
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Features/ }));
    expect(screen.queryByText(/from your books/)).toBeNull();
    expect(screen.queryByText(/^From /)).toBeNull();
  });
});

describe('items from the player’s books (SRD 5.2.1 Attunement)', () => {
  it('raises AC and saving throws with the Mothsilk Cloak only once attuned', async () => {
    const user = userEvent.setup();
    const cloak: InventoryItem = { id: 'it-cloak', ...inventoryFromOption(option('Mothsilk Cloak'), 1, EXPECTED_MERGED.equipment) };
    start({ inventory: [...sampleCharacter().inventory, cloak] });
    const saveBefore = savingThrowModifier(sheet(), 'wis');
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Inventory/ }));
    const row = screen.getByText('Mothsilk Cloak').closest('li') as HTMLElement;
    expect(within(row).getByText(/Requires attunement · \+1 AC and saving throws/)).toBeInTheDocument();
    expect(within(row).getByText(`From ${GLOAMWOOD_TITLE}`)).toBeInTheDocument();
    expect(sheet().armorClass).toBe(12);

    await user.click(within(row).getByRole('button', { name: 'Attune to Mothsilk Cloak' }));
    expect(sheet().armorClass).toBe(13);
    expect(savingThrowModifier(sheet(), 'wis')).toBe(saveBefore + 1);
    expect(vi.mocked(useGame.getState().queueDmNotice).mock.calls.at(-1)?.[0]).toBe('Player attuned to Mothsilk Cloak (AC 12 → 13; saving throws now include Mothsilk Cloak +1)');
  });

  it('reads "Requires attunement (by a Wizard)" and shows the book’s text live, or where it is', async () => {
    const user = userEvent.setup();
    const lantern = item({ name: 'Lantern of Hollow Light', magic: true, category: 'magic-item', requiresAttunement: true, attunementBy: 'a Wizard', compendiumId: LANTERN.id, ref: { ...importedRef(), entryId: LANTERN.id, kind: 'magic-item', entryName: LANTERN.name, textHash: '', textCopied: false } });
    const gone = item({ name: 'Gloam Lamp', magic: true, requiresAttunement: false, ref: { ...importedRef(), entryId: 'lib:gloam:999', kind: 'magic-item', entryName: 'Gloam Lamp', textHash: '', textCopied: false } });
    const sword = item({ name: 'Ember Blade', category: 'weapon', magic: true, requiresAttunement: false, bonuses: { attack: 1, damage: 1 } });
    start({ inventory: [lantern, gone, sword] });
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Inventory/ }));
    const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement;
    expect(within(row('Lantern of Hollow Light')).getByText('Requires attunement (by a Wizard)')).toBeInTheDocument();
    await user.click(within(row('Lantern of Hollow Light')).getByText('Details'));
    expect(within(row('Lantern of Hollow Light')).getByText('This lantern burns without oil.')).toBeInTheDocument();
    // The library is read live: the line says the book is missing once it knows no copy is here.
    expect(await within(row('Gloam Lamp')).findByText(`From “${GLOAMWOOD_TITLE}”, which isn't on this device.`)).toBeInTheDocument();
    // An item that says it doesn't need attunement has no Attune button.
    expect(within(row('Gloam Lamp')).queryByRole('button', { name: /Attune/ })).toBeNull();
    expect(within(row('Ember Blade')).getByText('+1 to attack and damage rolls — your DM adds it')).toBeInTheDocument();
  });

  it('P3: an item’s own words over a pulled placeholder show under Details despite a stale ref.redacted; the placeholder never does', async () => {
    const user = userEvent.setup();
    const RULING = 'DM ruling: the lantern lights only while its bearer whispers.';
    const pulledRef = { ...importedRef(), entryId: LANTERN.id, kind: 'magic-item' as const, entryName: LANTERN.name, textCopied: true, redacted: true as const };
    const lantern = item({ name: 'Lantern of Hollow Light', magic: true, compendiumId: LANTERN.id, description: RULING, ref: pulledRef });
    const cloak = item({ name: 'Mothsilk Cloak', magic: true, compendiumId: CLOAK_ENTRY.id, description: importedPlaceholder(GLOAMWOOD_TITLE), ref: { ...pulledRef, entryId: CLOAK_ENTRY.id, entryName: CLOAK_ENTRY.name } });
    start({ inventory: [lantern, cloak] });
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Inventory/ }));
    const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement;
    await user.click(within(row('Lantern of Hollow Light')).getByText('Details'));
    expect(within(row('Lantern of Hollow Light')).getByText(RULING)).toBeInTheDocument();
    expect(within(row('Lantern of Hollow Light')).getByText('This lantern burns without oil.')).toBeInTheDocument();
    await user.click(within(row('Mothsilk Cloak')).getByText('Details'));
    expect(within(row('Mothsilk Cloak')).getByText('Woven from the silk of a thousand moths.')).toBeInTheDocument();
    expect(row('Mothsilk Cloak').textContent).not.toContain('was left out of this copy');
  });

  it('links an added item by its exact name to the catalog or the rules index; other names stay as typed', async () => {
    const user = userEvent.setup();
    start({ inventory: [] });
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Inventory/ }));
    const add = async (name: string) => {
      await user.type(screen.getByLabelText('Item name'), name);
      await user.click(screen.getByRole('button', { name: 'Add' }));
    };
    await add('mothsilk cloak');
    await add('Lantern of Hollow Light');
    await add('Odd Rock');
    const [cloak, lantern, rock] = sheet().inventory;
    expect(cloak).toMatchObject({ name: 'Mothsilk Cloak', magic: true, requiresAttunement: true, bonuses: { ac: 1, savingThrows: 1 }, compendiumId: option('Mothsilk Cloak').id });
    expect(cloak.ref).toMatchObject({ kind: 'magic-item', textCopied: false });
    expect(cloak.description).not.toMatch(/thousand moths/);
    expect(lantern).toMatchObject({ name: 'Lantern of Hollow Light', magic: true, category: 'magic-item', requiresAttunement: true, attunementBy: 'a Wizard', compendiumId: LANTERN.id });
    expect(lantern.ref).toMatchObject({ entryId: LANTERN.id, textCopied: false });
    expect(rock).toEqual({ id: expect.any(String), name: 'Odd Rock', quantity: 1, category: 'gear' });
  });

  it('B9: keeps the category the player chose when the linked entry has none, so a weapon can be equipped', async () => {
    const user = userEvent.setup();
    // A book's item only the rules index knows (no catalog option), and the SRD's Ammunition (not in the catalog).
    const thornwhip: CompendiumEntry = { id: 'lib:gloam:30', sourceId: 'gloam', sourceName: GLOAMWOOD_TITLE, kind: 'item', name: 'Thornwhip', text: 'An invented whip.' };
    const ammunition: CompendiumEntry = { id: 'srd:item:ammunition', sourceId: 'srd-5.2.1', sourceName: 'SRD 5.2.1', kind: 'item', name: 'Ammunition', text: 'Arrows and bolts.' };
    mocks.entries = [thornwhip, ammunition];
    start({ inventory: [] });
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Inventory/ }));
    const add = async (name: string, category: string) => {
      await user.type(screen.getByLabelText('Item name'), name);
      await user.selectOptions(screen.getByLabelText('Category'), category);
      await user.click(screen.getByRole('button', { name: 'Add' }));
    };
    await add('Thornwhip', 'weapon');
    await add('Ammunition', 'consumable');
    await add('Hookstaff', 'treasure');
    const [whip, ammo, staff] = sheet().inventory;
    expect(whip).toMatchObject({ name: 'Thornwhip', category: 'weapon', compendiumId: thornwhip.id, ref: { entryId: thornwhip.id, textCopied: false } });
    expect(whip.magic).toBeUndefined();
    expect(ammo).toMatchObject({ name: 'Ammunition', category: 'consumable', compendiumId: ammunition.id });
    // A catalog option keeps its own category (the numbers and kind come with the link).
    expect(staff).toMatchObject({ name: 'Hookstaff', category: 'weapon' });
    expect(screen.getByRole('button', { name: 'Equip Thornwhip' })).toBeInTheDocument();
  });

  it('S4: says a switched-off book is switched off, and only a book that is gone "isn\'t on this device"', async () => {
    const user = userEvent.setup();
    const staff = { id: 'it-staff', ...inventoryFromOption(option('Hookstaff'), 1, EXPECTED_MERGED.equipment) };
    // Another (invented) book, which this device has no copy of.
    const otherBook = { sourceId: 'other', sourceTitle: 'The Lantern Ledger', bookFingerprint: '0123456789abcdef' };
    const gone = item({ name: 'Gloam Lamp', magic: true, requiresAttunement: false, ref: { ...importedRef(), ...otherBook, entryId: 'lib:other:999', kind: 'magic-item', entryName: 'Gloam Lamp', textHash: '', textCopied: false } });
    const base = sampleCharacter();
    const spell = { id: 'lib:gloam:40', name: 'Ashen Choir', level: 2, prepared: true, source: 'Wizard', ref: { ...importedRef(), entryId: 'lib:gloam:40', kind: 'spell' as const, entryName: 'Ashen Choir', textHash: '', textCopied: false } };
    // The book is on this device, switched off: the index has none of its entries.
    await saveLibrarySource(gloamwoodSource('gloam', 'md', { enabled: false }), []);
    try {
      start({ inventory: [staff, gone], spellcasting: { ...base.spellcasting!, spells: [...base.spellcasting!.spells, spell] } });
      render(<Harness />);
      await user.click(screen.getByRole('tab', { name: /Inventory/ }));
      const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement;
      expect(await within(row('Hookstaff')).findByText(`From “${GLOAMWOOD_TITLE}”, which is switched off in your Library.`)).toBeInTheDocument();
      expect(row('Hookstaff').textContent).not.toMatch(/isn't on this device/);
      expect(within(row('Gloam Lamp')).getByText('From “The Lantern Ledger”, which isn\'t on this device.')).toBeInTheDocument();
      await user.click(screen.getByRole('tab', { name: /Spells/ }));
      await user.click(screen.getByRole('button', { name: 'Ashen Choir' }));
      expect(await screen.findByText(`From “${GLOAMWOOD_TITLE}”, which is switched off in your Library.`)).toBeInTheDocument();
    } finally {
      await deleteLibrarySource('gloam');
    }
  });
});

describe('spells from the player’s books', () => {
  it('says a spell’s book isn’t on this device when its text can’t be found', async () => {
    const user = userEvent.setup();
    const base = sampleCharacter();
    const spell = { id: 'lib:other:40', name: 'Ashen Choir', level: 2, prepared: true, source: 'Wizard', ref: { ...importedRef(), entryId: 'lib:other:40', kind: 'spell' as const, entryName: 'Ashen Choir', textHash: '', textCopied: false } };
    start({ spellcasting: { ...base.spellcasting!, spells: [...base.spellcasting!.spells, spell] } });
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: /Spells/ }));
    const row = screen.getByRole('button', { name: 'Ashen Choir' }).closest('li') as HTMLElement;
    expect(within(row).getByText(`From ${GLOAMWOOD_TITLE}`)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ashen Choir' }));
    expect(await screen.findByText(`From “${GLOAMWOOD_TITLE}”, which isn't on this device.`)).toBeInTheDocument();
  });
});
