import { describe, expect, it } from 'vitest';
import compendiumRaw from '../../../public/srd/compendium.json?raw';
import { knownSpellFromEntry } from '@/data/options/levelUpChoices';
import { owedSpells } from '@/data/options/spellPicks';
import { nameKey } from '@/lib/id';
import { sampleCharacter } from '@/test/fixtures';
import { GLOAMWOOD_TITLE, SRD_BUILDER_DATA } from '@/test/structuredFixtures';
import { SHEET_TEXT_MAX } from '@/engine';
import type { Character, ClassLevel, ClassOption, CompendiumEntry, InventoryItem, KnownSpell, SpellPicksOwed } from '@/types';
import {
  deathSaveMarkChange,
  dmSheetLengthHint,
  endHpMaxChange,
  hpMaxChange,
  itemAttuneChange,
  itemEquipChange,
  notesChange,
  personalityChange,
  preparedChange,
  removeItemChange,
  restSpellChange,
  skipSpellPicksChange,
  spellPicksChange,
  type SpellPicksChoice,
} from './sheetChanges';

// SRD 5.2.1 Magic Items: Ring of Protection — "+1 bonus to AC and saving throws" while attuned.
describe('sheet gear changes keep AC in step', () => {
  const withRing = () =>
    sampleCharacter({
      armorClass: 12,
      inventory: [{ id: 'ring', name: 'Ring of Protection', quantity: 1, magic: true, category: 'magic-item' }],
    });

  it('attuning a Ring of Protection raises AC and says so', () => {
    const r = itemAttuneChange(withRing(), 'ring', true);
    expect(r.character.armorClass).toBe(13);
    // The save bonus too: the DM's sheet from the start of the session doesn't have it.
    expect(r.notice).toBe('Player attuned to Ring of Protection (AC 12 → 13; saving throws now include Ring of Protection +1)');
  });

  it('ending attunement lowers it again, and says the save bonus is gone', () => {
    const attuned = itemAttuneChange(withRing(), 'ring', true).character;
    const r = itemAttuneChange(attuned, 'ring', false);
    expect(r.character.armorClass).toBe(12);
    expect(r.notice).toBe('Player ended attunement to Ring of Protection (AC 13 → 12; saving throws no longer include Ring of Protection +1)');
  });

  it('equipping non-armor gear leaves an unchanged AC alone', () => {
    const c = sampleCharacter();
    const r = itemEquipChange(c, 'item-spellbook', true, null);
    expect(r.character.armorClass).toBe(c.armorClass);
    expect(r.notice).not.toMatch(/AC/);
  });
});

// The AC an equip, attune or removal can't settle on its own: the DM, whose ruling it is, reads why at the end of the
// notice's one line (notices are parsed back line by line); the player, who can't set the AC, gets a plain toast.
describe('sheet gear changes pass on what syncArmorClass warns', () => {
  const shield: InventoryItem = { id: 'shield', name: 'Shield', quantity: 1, category: 'shield' };

  // SRD 5.2.1 Spells: Mage Armor (base AC 13 + Dexterity modifier) isn't counted by the app, so the DM set the AC by hand;
  // Equipment: a Shield adds 2.
  it('keeps an AC set by hand (Mage Armor) when a Shield goes on, and says what gear now gives', () => {
    const c = sampleCharacter({ armorClass: 15, armorTraining: ['Shields'], inventory: [shield] });
    const r = itemEquipChange(c, 'shield', true, null);
    expect(r.character.armorClass).toBe(15);
    const kept =
      'AC kept at 15: it differs from the 12 that gear and features gave, so it may include a spell such as Mage Armor or a manual change. Gear and features now give AC 14 (10 + DEX 2 + Shield 2); update the AC if that is right.';
    expect(r.notice).toBe(`Player equipped Shield — ${kept}`);
    expect(r.warning).toBe("Your AC stays 15: your gear alone can't settle it, so your DM will be told with your next message.");
  });

  // SRD 5.2.1 Magic Items: Cloak of Protection — +1 to AC and saving throws while attuned.
  it('keeps the saving-throw note in its parentheses and the warning after it when an attunement meets a hand-set AC', () => {
    const cloak: InventoryItem = { id: 'cloak', name: 'Cloak of Protection', quantity: 1, magic: true, category: 'magic-item' };
    const r = itemAttuneChange(sampleCharacter({ armorClass: 15, inventory: [cloak] }), 'cloak', true);
    expect(r.character.armorClass).toBe(15);
    expect(r.notice).toMatch(/^Player attuned to Cloak of Protection \(saving throws now include Cloak of Protection \+1\) — AC kept at 15: .*Gear and features now give AC 13 \(10 \+ DEX 2 \+ Cloak of Protection 1\); update the AC if that is right\.$/);
    expect(r.warning).toMatch(/^Your AC stays 15: /);
  });

  it('says so when the player puts on armor whose stats the app does not know', () => {
    const hauberk: InventoryItem = { id: 'hauberk', name: 'Saltglass Hauberk', quantity: 1, category: 'armor' };
    const c = sampleCharacter({ armorTraining: ['Light armor', 'Medium armor', 'Heavy armor', 'Shields'], inventory: [hauberk] });
    const r = itemEquipChange(c, 'hauberk', true, null);
    expect(r.character.armorClass).toBe(12);
    const unknown = "AC kept at 12: Saltglass Hauberk's armor stats are unknown, so set the AC by hand.";
    expect(r.notice).toBe(`Player equipped Saltglass Hauberk — ${unknown}`);
    expect(r.warning).toMatch(/^Your AC stays 12: /);
  });

  it('lowers the AC when the player removes the Shield they wear, and says so; other gear goes as before', () => {
    const c = sampleCharacter({ armorClass: 14, armorTraining: ['Shields'], inventory: [{ ...shield, equipped: true }, ...sampleCharacter().inventory] });
    const r = removeItemChange(c, 'shield');
    expect(r.character.armorClass).toBe(12);
    expect(r.character.acFormula).toBe('10 + DEX 2');
    expect(r.notice).toBe('Player removed Shield from their inventory (AC 14 → 12)');
    expect(r.warning).toBeUndefined();
    expect(removeItemChange(c, 'item-robe')).toMatchObject({ notice: 'Player removed Robe from their inventory', character: { armorClass: 14 } });
  });

  it('keeps a hand-set AC when the worn Shield is removed, and passes on the warning', () => {
    const c = sampleCharacter({ armorClass: 17, armorTraining: ['Shields'], inventory: [{ ...shield, equipped: true }] });
    const r = removeItemChange(c, 'shield');
    expect(r.character.armorClass).toBe(17);
    expect(r.notice).toMatch(/^Player removed Shield from their inventory — AC kept at 17: it differs from the 14 that gear and features gave, .* Gear and features now give AC 12 \(10 \+ DEX 2\); update the AC if that is right\.$/);
    expect(r.warning).toMatch(/^Your AC stays 17: /);
    expect(r.notice).not.toContain('\n');
  });
});

describe('personality edits tell the DM', () => {
  it('quotes a short edit whole', () => {
    expect(personalityChange(sampleCharacter(), 'ideals', 'Freedom.').notice).toBe('Player updated their ideals: “Freedom.”');
  });

  it('quotes the opening of a long edit and says get_character_sheet has the whole text, on one line', () => {
    const backstory = [
      'Kestrel Vane grew up on the salt flats east of Harrowmere, where the caravans stop only to water their oxen.',
      'He fights with twin hooked blades joined by a length of black chain.',
    ].join('\n\n');
    const r = personalityChange(sampleCharacter(), 'backstory', backstory);
    expect(r.character.personality.backstory).toBe(backstory);
    // Notices reach the DM as one "- " line each and are parsed back line by line.
    expect(r.notice).not.toContain('\n');
    expect(r.notice).toBe(
      'Player updated their backstory: “Kestrel Vane grew up on the salt flats east of Harrowmere,…” (its opening; get_character_sheet has the whole text)',
    );
  });
});

describe('notices quote whole characters, and notes edits read like personality edits', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it('never ends a quote on half an emoji', () => {
    const backstory = `${'x'.repeat(58)}🐉 and then the rest of a very long first paragraph.`;
    const notice = personalityChange(sampleCharacter(), 'backstory', backstory).notice ?? '';
    expect(notice).not.toMatch(lone);
    expect(notice).toContain(`“${'x'.repeat(58)}…”`);
  });

  it('quotes a notes edit, says where the whole text is, and says when the notes were cleared', () => {
    const c = sampleCharacter({ notes: 'Old notes.' });
    expect(notesChange(c, 'Ask Old Tam about the ferry.').notice).toBe('Player updated their notes on the sheet: “Ask Old Tam about the ferry.”');
    const long = notesChange(c, 'Session 4: the ferryman owes us a crossing; the lamplighter keeps a second ledger.').notice;
    expect(long).toMatch(/^Player updated their notes on the sheet: “.+…” \(its opening; get_character_sheet has the whole text\)$/);
    expect(notesChange(c, '  ').notice).toBe('Player cleared their notes on the sheet');
  });

  it('tells the player when a field is past what the DM sheet carries', () => {
    expect(dmSheetLengthHint(undefined)).toBeUndefined();
    expect(dmSheetLengthHint('A long backstory, but a real one.')).toBeUndefined();
    expect(dmSheetLengthHint('x'.repeat(SHEET_TEXT_MAX))).toBeUndefined();
    expect(dmSheetLengthHint('x'.repeat(SHEET_TEXT_MAX + 1))).toBe(
      "The DM's sheet carries the first 20,000 characters of this; past that it tells the DM the rest is left out.",
    );
  });
});

// The player's Hit Point maximum changes (HpMaxDialog, the chips' ×), on the real engine: one notice line each for the DM.
describe('Hit Point maximum changes from the sheet', () => {
  it('tells the DM about a raise, a reduction and a lasting change in the engine\'s words (srd:spell:aid, srd:monster:wraith)', () => {
    const aid = hpMaxChange(sampleCharacter(), { name: 'Aid', change: 5, ends: 'long-rest' });
    expect(aid.character.hp).toEqual({ max: 22, current: 17, temp: 0 });
    expect(aid.notice).toBe('Player changed their Hit Point maximum: HP maximum 17 → 22, HP 12 → 17 (Aid +5, until a Long Rest)');
    const drain = hpMaxChange(sampleCharacter(), { name: 'Life Drain', change: -10, ends: 'long-rest' });
    expect(drain.notice).toBe('Player changed their Hit Point maximum: HP maximum 17 → 7, HP 12 → 7 (Life Drain −10, until a Long Rest)');
    const lasting = hpMaxChange(sampleCharacter(), { name: 'Tough (missed at 1st level)', change: 6, ends: 'never' });
    expect(lasting.notice).toBe('Player changed their Hit Point maximum: HP maximum 17 → 23, HP 12 → 18 (Tough (missed at 1st level) +6, lasting)');
  });

  it('tells the DM about an end, and gives a refusal to the player alone', () => {
    const aided = hpMaxChange(sampleCharacter(), { name: 'Aid', change: 5, ends: 'long-rest' }).character;
    const ended = endHpMaxChange(aided, 'Aid', 'long-rest');
    expect(ended.character.hp).toEqual({ max: 17, current: 17, temp: 0 });
    expect(ended.notice).toBe('Player ended a Hit Point maximum adjustment: Aid +5 ends: HP maximum 22 → 17');
    const again = hpMaxChange(aided, { name: 'Aid', change: 5, ends: 'long-rest' });
    expect(again.character).toBe(aided);
    expect(again.notice).toBeNull();
    expect(again.warning).toContain("the same spell's effects don't combine");
    expect(endHpMaxChange(aided, 'Aid', 'when-ended')).toMatchObject({ character: aided, notice: null });
    // Nothing ended (a lasting entry that stays): no notice, only the reason.
    const boon = hpMaxChange(sampleCharacter(), { name: 'Boon', change: 10, ends: 'never' }).character; // 22/27
    const cursed = hpMaxChange(boon, { name: 'Mummy Rot', change: -25, ends: 'when-ended' }).character; // 2/2
    expect(endHpMaxChange(cursed, 'Boon')).toMatchObject({ character: cursed, notice: null, warning: 'Boon +10 stays: taking it back would leave a Hit Point maximum below 1.' });
  });

  it("won't clear a death mark while the maximum is 0 (srd:rule:...-instant-death: \"A creature dies if its Hit Point maximum reaches 0.\")", () => {
    const dead = hpMaxChange(sampleCharacter(), { name: 'Life Drain', change: -20, ends: 'long-rest' }).character;
    expect(dead.deathSaves.dead).toBe(true);
    const refused = deathSaveMarkChange(dead, 'failures', 2);
    expect(refused.character).toBe(dead);
    expect(refused.warning).toBe("Your hero's Hit Point maximum is 0: end what lowered it first (its × on the Hit Points bar).");
    const restored = endHpMaxChange(dead, 'Life Drain').character;
    expect(deathSaveMarkChange(restored, 'failures', 2).character.deathSaves.dead).toBe(false);
  });
});

describe('prepared checkboxes on the Spells tab', () => {
  it('prepares and unprepares a spell by id and tells the DM', () => {
    // The sample Wizard's spellbook holds Sleep unprepared (srd:rule:wizard-spellcasting: prepared "from your spellbook").
    const prepared = preparedChange(sampleCharacter(), 'srd:spell:sleep', true);
    expect(prepared.character.spellcasting?.spells.find((s) => s.id === 'srd:spell:sleep')?.prepared).toBe(true);
    expect(prepared.notice).toBe('Player prepared Sleep');
    const unprepared = preparedChange(prepared.character, 'srd:spell:sleep', false);
    expect(unprepared.character.spellcasting?.spells.find((s) => s.id === 'srd:spell:sleep')?.prepared).toBe(false);
    expect(unprepared.notice).toBe('Player unprepared Sleep');
  });

  it("changes nothing for a spell already so, one that's gone, or one always prepared (srd:rule:gaining-spells)", () => {
    const c = sampleCharacter();
    expect(preparedChange(c, 'srd:spell:shield', true)).toEqual({ character: c, notice: null, warning: null });
    expect(preparedChange(c, 'srd:spell:wish', true).character).toBe(c);
    // "A spell that you always have prepared doesn't count against the number of spells on that list": no checkbox.
    const always: KnownSpell = { id: 'srd:spell:bless', name: 'Bless', level: 1, prepared: true, alwaysPrepared: true, source: 'Life Domain' };
    const blessed = sampleCharacter({ spellcasting: { ...c.spellcasting!, spells: [...c.spellcasting!.spells, always] } });
    expect(preparedChange(blessed, 'srd:spell:bless', false).character).toBe(blessed);
  });
});

// The choices form's changes on the real engine, the SRD's own class tables and its spells.
describe("spell choices from the sheet (SRD 5.2.1, each class's Spellcasting)", () => {
  const SPELLS = (JSON.parse(compendiumRaw) as CompendiumEntry[]).filter((e) => e.kind === 'spell');
  const entryOf = (name: string): CompendiumEntry => {
    const found = SPELLS.find((e) => nameKey(e.name) === nameKey(name));
    if (!found) throw new Error(`no SRD spell ${name}`);
    return found;
  };
  /** A sheet spell for a picked rules-index entry, as the form makes it. */
  const pick = (name: string) => knownSpellFromEntry(entryOf(name)) as KnownSpell;
  const own = (name: string, source: string, extra: Partial<KnownSpell> = {}): KnownSpell => ({ ...pick(name), source, ...extra });
  const cls = (name: string): ClassOption => {
    const found = SRD_BUILDER_DATA.classes.find((c) => c.name === name);
    if (!found) throw new Error(`no SRD class ${name}`);
    return found;
  };
  const entry = (name: string, level: number): ClassLevel => {
    const o = cls(name);
    return { classId: o.id, name: o.name, level, hitDie: o.hitDie, casterType: o.casterType, ...(o.spellcastingAbility ? { spellcastingAbility: o.spellcastingAbility } : {}) };
  };
  /** `n` placeholder spells for a class: they count, and no picked name clashes with them. */
  const fill = (className: string, n: number, level: number, tag = 'x'): KnownSpell[] =>
    Array.from({ length: n }, (_, i) => ({ id: `fill-${className}-${tag}${level}-${i}`, name: `${className} ${tag}${level}-${i}`, level, prepared: true, source: className }));
  const hero = (classes: ClassLevel[], spells: KnownSpell[], picks: SpellPicksOwed[]): Character =>
    sampleCharacter({ classes, features: [], spellcasting: { ability: 'cha', slots: {}, spells, concentratingOn: null, spellPicks: picks } });
  const choice = (classId: string, extra: Partial<SpellPicksChoice>): SpellPicksChoice => ({ classId, cantrips: [], spellbook: [], prepared: [], prepare: [], ...extra });
  const spellsOf = (c: Character) => c.spellcasting?.spells ?? [];
  const named = (c: Character, name: string) => spellsOf(c).find((s) => s.name === name);
  const openPicks = (c: Character) => c.spellcasting?.spellPicks ?? [];

  /** The sample Wizard 3 at Wizard 4 with its choices open: 1 cantrip, 6 spellbook spells and 2 prepared spells owed. */
  const wizard4 = (): Character => {
    const base = sampleCharacter();
    return { ...base, classes: base.classes.map((cl) => ({ ...cl, level: 4 })), spellcasting: { ...base.spellcasting!, spellPicks: [{ classId: 'srd:class:wizard' }] } };
  };

  it("adds a Wizard's cantrip and book spells, prepares from the book, and keeps the record while the book is short (srd:rule:wizard-spellcasting)", () => {
    // "Whenever you gain a Wizard level after 1, add two Wizard spells of your choice to your spellbook", and prepared
    // spells are "chosen from your spellbook": a new book spell is prepared only when chosen to prepare.
    const r = spellPicksChange(
      wizard4(),
      cls('Wizard'),
      choice('srd:class:wizard', { cantrips: [pick('Ray of Frost')], spellbook: [pick('Web'), pick('Hold Person')], prepare: ['srd:spell:web', 'srd:spell:sleep'] }),
    );
    expect(r.notice).toBe('Player chose spells for Wizard 4: cantrip Ray of Frost; spellbook Web, Hold Person; prepared Web, Sleep; still to choose: 4 spellbook spells (4 of level 1)');
    expect(named(r.character, 'Ray of Frost')).toMatchObject({ id: 'srd:spell:ray-of-frost', level: 0, source: 'Wizard', prepared: true });
    expect(named(r.character, 'Web')).toMatchObject({ level: 2, source: 'Wizard', prepared: true, concentration: true });
    expect(named(r.character, 'Hold Person')).toMatchObject({ source: 'Wizard', prepared: false });
    expect(named(r.character, 'Sleep')?.prepared).toBe(true);
    // The table's count is met for cantrips and prepared spells; the record stays for the book, without swaps.
    expect(owedSpells(r.character, r.character.classes[0], cls('Wizard'))).toMatchObject({ cantrips: { owed: 0 }, prepared: { owed: 0 }, spellbook: { owed: 4 } });
    expect(openPicks(r.character)).toEqual([{ classId: 'srd:class:wizard' }]);
    // The rest of the book closes the choices: Misty Step is in the book already (a held name is never taken again); the
    // places left are the earlier levels', of level 1 ("Each of these spells must be of a level for which you have spell
    // slots"), so Shatter and Knock have none; and a fifth new spell has no place.
    const more = ['Find Familiar', 'Mage Armor', 'Thunderwave', 'Misty Step', 'Shatter', 'Grease', 'Knock', 'Feather Fall'].map(pick);
    const done = spellPicksChange(r.character, cls('Wizard'), choice('srd:class:wizard', { spellbook: more }));
    expect(done.notice).toBe('Player chose spells for Wizard 4: spellbook Find Familiar, Mage Armor, Thunderwave, Grease');
    expect(openPicks(done.character)).toEqual([]);
    for (const name of ['Shatter', 'Knock', 'Feather Fall']) expect(named(done.character, name)).toBeUndefined();
    expect(spellsOf(done.character).filter((s) => s.name === 'Misty Step')).toHaveLength(1);
  });

  it('names a book spell with its book, as feats are', () => {
    const ashen: CompendiumEntry = { id: 'lib:gloam:40', sourceId: 'gloam', sourceName: GLOAMWOOD_TITLE, kind: 'spell', name: 'Ashen Choir', text: 'Invented.', data: { level: 2, classes: ['Wizard'] } };
    const r = spellPicksChange(wizard4(), cls('Wizard'), choice('srd:class:wizard', { spellbook: [knownSpellFromEntry(ashen)!], prepare: [ashen.id] }));
    expect(r.notice).toBe(
      `Player chose spells for Wizard 4: spellbook Ashen Choir (${GLOAMWOOD_TITLE}); prepared Ashen Choir (${GLOAMWOOD_TITLE}); still to choose: 1 cantrip, 5 spellbook spells (1 up to level 2 and 4 of level 1) and 1 prepared spell`,
    );
    expect(named(r.character, 'Ashen Choir')?.ref).toMatchObject({ entryId: 'lib:gloam:40', textCopied: false });
  });

  /** A Sorcerer 5 at its table (5 cantrips, 9 prepared, Fire Bolt and Burning Hands among them) gaining Sorcerer 6. */
  const sorcerer6 = (): Character =>
    hero(
      [entry('Sorcerer', 6)],
      [own('Fire Bolt', 'Sorcerer'), ...fill('Sorcerer', 4, 0), own('Burning Hands', 'Sorcerer'), ...fill('Sorcerer', 8, 1)],
      [{ classId: 'srd:class:sorcerer', replaceSpell: true, replaceCantrip: true }],
    );

  it("replaces a spell on gaining a level, one for one, and closes what's met (srd:rule:sorcerer-spellcasting)", () => {
    // "Whenever you gain a Sorcerer level, you can replace one spell on your list with another Sorcerer spell for which
    // you have spell slots." Sorcerer 6 prepares 10: one new spell, and the replacement takes the given-up one's place.
    const r = spellPicksChange(sorcerer6(), cls('Sorcerer'), choice('srd:class:sorcerer', { prepared: [pick('Haste'), pick('Fireball')], giveUpSpell: 'srd:spell:burning-hands' }));
    expect(r.notice).toBe('Player chose spells for Sorcerer 6: prepared Haste; replaced Burning Hands with Fireball');
    expect(named(r.character, 'Burning Hands')).toBeUndefined();
    expect(named(r.character, 'Fireball')).toMatchObject({ source: 'Sorcerer', prepared: true });
    expect(owedSpells(r.character, r.character.classes[0], cls('Sorcerer'))?.prepared).toEqual({ target: 10, held: 10, owed: 0 });
    expect(openPicks(r.character)).toEqual([]);
  });

  it('replaces a cantrip too; a spell given up with no replacement picked stays (srd:rule:sorcerer-spellcasting)', () => {
    // "Whenever you gain a Sorcerer level, you can replace one of your cantrips from this feature with another Sorcerer cantrip."
    const swapped = spellPicksChange(sorcerer6(), cls('Sorcerer'), choice('srd:class:sorcerer', { cantrips: [pick('Ray of Frost')], giveUpCantrip: 'srd:spell:fire-bolt' }));
    expect(swapped.notice).toBe('Player chose spells for Sorcerer 6: replaced Fire Bolt with Ray of Frost; still to choose: 1 prepared spell');
    expect(named(swapped.character, 'Fire Bolt')).toBeUndefined();
    // The level's swaps lapse with its choices; what is still owed stays open.
    expect(openPicks(swapped.character)).toEqual([{ classId: 'srd:class:sorcerer' }]);
    const start = sorcerer6();
    const giveUpOnly = spellPicksChange(start, cls('Sorcerer'), choice('srd:class:sorcerer', { giveUpSpell: 'srd:spell:burning-hands' }));
    expect(giveUpOnly.character).toBe(start);
    expect(giveUpOnly.notice).toBeNull();
  });

  it('revalidates on the latest sheet: a name it now holds, a spell given up that is gone, picks past the table (srd:rule:gaining-spells)', () => {
    const latest = sorcerer6();
    // Meanwhile the DM added Haste and another Sorcerer spell, and Burning Hands is gone: the table has no room left but
    // the swap's, and the swap has nothing to give up.
    const changed: Character = {
      ...latest,
      spellcasting: { ...latest.spellcasting!, spells: [...spellsOf(latest).filter((s) => s.name !== 'Burning Hands'), own('Haste', 'Granted in play'), ...fill('Sorcerer', 1, 1, 'dm')] },
    };
    const r = spellPicksChange(changed, cls('Sorcerer'), choice('srd:class:sorcerer', { prepared: [pick('Haste'), pick('Fireball'), pick('Fly')], giveUpSpell: 'srd:spell:burning-hands' }));
    expect(r.notice).toBe('Player chose spells for Sorcerer 6: prepared Fireball');
    expect(named(r.character, 'Haste')).toMatchObject({ source: 'Granted in play' });
    expect(named(r.character, 'Fly')).toBeUndefined();
    // A record the sheet no longer has (closed elsewhere) takes no swap: the given-up spell stays.
    const closed: Character = { ...latest, spellcasting: { ...latest.spellcasting!, spellPicks: [] } };
    const noSwap = spellPicksChange(closed, cls('Sorcerer'), choice('srd:class:sorcerer', { prepared: [pick('Haste'), pick('Fireball')], giveUpSpell: 'srd:spell:burning-hands' }));
    expect(noSwap.notice).toBe('Player chose spells for Sorcerer 6: prepared Haste');
    expect(named(noSwap.character, 'Burning Hands')).toBeDefined();
  });

  it('gives up only a spell on the list: an unprepared one frees no place (srd:rule:sorcerer-spellcasting)', () => {
    // "you can replace one spell on your list with another Sorcerer spell": Burning Hands, left unprepared, isn't on the
    // list, so it takes no swap; the class keeps to its table's 10.
    const start = sorcerer6();
    const unprepared = { ...start, spellcasting: { ...start.spellcasting!, spells: spellsOf(start).map((s) => (s.name === 'Burning Hands' ? { ...s, prepared: false } : s)) } };
    const r = spellPicksChange(unprepared, cls('Sorcerer'), choice('srd:class:sorcerer', { prepared: [pick('Haste'), pick('Fireball'), pick('Counterspell')], giveUpSpell: 'srd:spell:burning-hands' }));
    expect(r.notice).toBe('Player chose spells for Sorcerer 6: prepared Haste, Fireball');
    expect(named(r.character, 'Burning Hands')).toMatchObject({ prepared: false });
    expect(owedSpells(r.character, r.character.classes[0], cls('Sorcerer'))?.prepared).toEqual({ target: 10, held: 10, owed: 0 });
  });

  it("keeps each level's limit on spellbook spells chosen late, and prepares a copied spell from the book (srd:rule:wizard-spellcasting)", () => {
    // "Whenever you gain a Wizard level after 1, add two Wizard spells … Each of these spells must be of a level for which
    // you have spell slots": a Wizard 3 at its table taken to Wizard 5 owes Wizard 4's two (level 1–2) and Wizard 5's two.
    const unprepared = (spells: KnownSpell[]) => spells.map((sp) => ({ ...sp, prepared: false }));
    const copy = own('Invisibility', 'Wizard (copied)', { prepared: false });
    const w = hero([entry('Wizard', 5)], [...fill('Wizard', 3, 0), ...fill('Wizard', 6, 1), ...unprepared(fill('Wizard', 4, 1, 'book')), copy], [{ classId: 'srd:class:wizard' }]);
    const r = spellPicksChange(
      w,
      cls('Wizard'),
      choice('srd:class:wizard', { spellbook: [pick('Fireball'), pick('Counterspell'), pick('Fly'), pick('Web'), pick('Haste')], prepare: ['srd:spell:invisibility'] }),
    );
    // Fly would be a third of level 3 and Haste a fifth spell: neither has a place.
    expect(r.notice).toBe('Player chose spells for Wizard 5: spellbook Fireball, Counterspell, Web; prepared Invisibility; still to choose: 1 cantrip, 1 spellbook spell (1 up to level 2) and 2 prepared spells');
    expect(named(r.character, 'Fly')).toBeUndefined();
    // The copy is prepared like the book's other spells and counts against the Prepared Spells column; it stays a copy.
    expect(named(r.character, 'Invisibility')).toMatchObject({ source: 'Wizard (copied)', prepared: true });
    expect(owedSpells(r.character, r.character.classes[0], cls('Wizard'))).toMatchObject({ spellbook: { owed: 1 }, prepared: { held: 7 }, bookCaps: [2] });
  });

  it("skips a class's choices: the record closes and the DM hears what wasn't chosen", () => {
    const r = skipSpellPicksChange(wizard4(), cls('Wizard'), 'srd:class:wizard');
    expect(r.notice).toBe('Player skipped their spell choices for Wizard 4 (not chosen: 1 cantrip, 6 spellbook spells and 2 prepared spells)');
    expect(openPicks(r.character)).toEqual([]);
    expect(spellsOf(r.character)).toEqual(spellsOf(wizard4()));
    // A level that only lets the class swap (srd:rule:bard-spellcasting, Bard 12): nothing new was owed.
    const bard = hero([entry('Bard', 12)], [...fill('Bard', 4, 0), ...fill('Bard', 16, 1)], [{ classId: 'srd:class:bard', replaceSpell: true, replaceCantrip: true }]);
    expect(skipSpellPicksChange(bard, cls('Bard'), 'srd:class:bard').notice).toBe('Player skipped their spell choices for Bard 12 (kept their spells)');
    // Nothing open: nothing to skip.
    expect(skipSpellPicksChange(r.character, cls('Wizard'), 'srd:class:wizard')).toMatchObject({ character: r.character, notice: null });
  });

  /** A Cleric 3 with its 6 prepared spells, Bless and Guiding Bolt among them. */
  const cleric3 = (): Character => hero([entry('Cleric', 3)], [...fill('Cleric', 3, 0), own('Bless', 'Cleric'), own('Guiding Bolt', 'Cleric'), ...fill('Cleric', 4, 1)], []);

  it("changes a Cleric's prepared spells after a Long Rest, one for one (srd:rule:cleric-spellcasting)", () => {
    // "Whenever you finish a Long Rest, you can change your list of prepared spells, replacing any of the spells there with
    // other Cleric spells for which you have spell slots."
    const r = restSpellChange(cleric3(), cls('Cleric'), { classId: 'srd:class:cleric', giveUp: ['srd:spell:bless'], picks: [pick('Sanctuary')] });
    expect(r.notice).toBe('Player changed their Cleric prepared spells (allowed after a Long Rest): Bless → Sanctuary');
    expect(named(r.character, 'Bless')).toBeUndefined();
    expect(named(r.character, 'Sanctuary')).toMatchObject({ source: 'Cleric', prepared: true });
    // Count-neutral: two given up and one picked replaces one; the table's count never moves.
    const one = restSpellChange(cleric3(), cls('Cleric'), { classId: 'srd:class:cleric', giveUp: ['srd:spell:bless', 'srd:spell:guiding-bolt'], picks: [pick('Spiritual Weapon')] });
    expect(one.notice).toBe('Player changed their Cleric prepared spells (allowed after a Long Rest): Bless → Spiritual Weapon');
    expect(named(one.character, 'Guiding Bolt')).toBeDefined();
    const before = owedSpells(cleric3(), cleric3().classes[0], cls('Cleric'))?.prepared;
    for (const c of [r.character, one.character]) expect(owedSpells(c, c.classes[0], cls('Cleric'))?.prepared).toEqual(before);
    // A replacement the sheet already holds, or above the class's own slots (Cleric 3: level 2), isn't taken.
    expect(restSpellChange(cleric3(), cls('Cleric'), { classId: 'srd:class:cleric', giveUp: ['srd:spell:bless'], picks: [pick('Guiding Bolt')] }).notice).toBeNull();
    expect(restSpellChange(cleric3(), cls('Cleric'), { classId: 'srd:class:cleric', giveUp: ['srd:spell:bless'], picks: [pick('Revivify')] }).notice).toBeNull();
    // A spell above the class's own spell level, recorded under its name, isn't on its list: nothing to give up there.
    const above = hero([entry('Cleric', 3)], [...fill('Cleric', 3, 0), own('Revivify', 'Cleric'), ...fill('Cleric', 6, 1)], []);
    expect(restSpellChange(above, cls('Cleric'), { classId: 'srd:class:cleric', giveUp: ['srd:spell:revivify'], picks: [pick('Sanctuary')] }).notice).toBeNull();
  });

  it('lets a Paladin replace one spell after a Long Rest, and a Wizard one cantrip (srd:rule:paladin-spellcasting, srd:rule:wizard-spellcasting)', () => {
    // Paladin: "Whenever you finish a Long Rest, you can replace one spell on your list with another Paladin spell".
    const paladin = hero([entry('Paladin', 3)], [own('Bless', 'Paladin'), own('Cure Wounds', 'Paladin'), ...fill('Paladin', 2, 1)], []);
    const r = restSpellChange(paladin, cls('Paladin'), { classId: 'srd:class:paladin', giveUp: ['srd:spell:bless', 'srd:spell:cure-wounds'], picks: [pick('Shield of Faith'), pick('Heroism')] });
    expect(r.notice).toBe('Player changed their Paladin prepared spells (allowed after a Long Rest): Bless → Shield of Faith');
    expect(named(r.character, 'Cure Wounds')).toBeDefined();
    // Wizard: "Whenever you finish a Long Rest, you can replace one of your cantrips from this feature with another Wizard
    // cantrip"; its prepared spells change with the sheet's checkboxes, so a spell given up here is left alone.
    const w = restSpellChange(sampleCharacter(), cls('Wizard'), {
      classId: 'srd:class:wizard',
      giveUp: ['srd:spell:shield'],
      picks: [pick('Mage Armor')],
      giveUpCantrip: 'srd:spell:light',
      cantrip: pick('Ray of Frost'),
    });
    expect(w.notice).toBe('Player changed their Wizard cantrips (allowed after a Long Rest): Light → Ray of Frost');
    expect(named(w.character, 'Shield')).toBeDefined();
    expect(named(w.character, 'Ray of Frost')).toMatchObject({ level: 0, source: 'Wizard' });
    // A Bard has no Long Rest change (srd:rule:bard-spellcasting: "Whenever you gain a Bard level").
    const bard = hero([entry('Bard', 3)], [own('Sleep', 'Bard')], []);
    expect(restSpellChange(bard, cls('Bard'), { classId: 'srd:class:bard', giveUp: ['srd:spell:sleep'], picks: [pick('Heroism')] }).character).toBe(bard);
  });
});
