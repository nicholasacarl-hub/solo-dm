/**
 * Pure sheet edits: each returns the new character plus a concise notice for the DM
 * ("Player changed HP 12 → 15"). Rules changes go through '@/engine'.
 */
import {
  acSpellNamed,
  acSpells,
  addCondition,
  addSpell,
  adjustHpMax,
  applyDamage,
  applyHealing,
  changeExhaustion,
  classSpellLevelCap,
  conditionKey,
  conditionsNaming,
  countedAcSpells,
  endAcSpell,
  endHpMaxAdjustments,
  matchStandardCondition,
  removeSpellById,
  saveSourcesChangeText,
  syncArmorClass,
  conditionName,
  ordinal,
  recordDeathSave,
  removeCondition,
  restoreSlot,
  SHEET_TEXT_MAX,
  setConcentration,
  sheetCutsText,
  setTempHp,
  spendSlot,
  type ConditionNaming,
  type HpMaxChange,
} from '@/engine';
import { namesSpell, withoutNote } from '@/engine/util';
import {
  bookSpellsOf,
  classSpellRules,
  classSpellsOf,
  closeSpellPicks,
  fitsBookCaps,
  owedSpells,
  owedSpellsSummary,
  swappableSpells,
  withoutSwaps,
} from '@/data/options/spellPicks';
import { nameKey } from '@/lib/id';
import { safeEnd } from '@/lib/text';
import type {
  Character,
  ClassOption,
  Currency,
  EquipmentOption,
  GameEvent,
  HpMaxEnds,
  InventoryItem,
  KnownSpell,
  Personality,
  SpellSlotLevel,
} from '@/types';
import type { SheetChange } from './useSheetActions';

const unchanged = (c: Character, warning?: string): SheetChange => ({ character: c, notice: null, warning: warning ?? null });

function firstWarning(events: readonly GameEvent[]): string | undefined {
  return events.find((e) => e.type === 'warning')?.message;
}

/** The text on one line, quoted; past `max`, cut at a word end when there is one, and never inside an emoji. */
function quote(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return `“${flat}”`;
  const head = flat.slice(0, safeEnd(flat, max - 1));
  const space = head.lastIndexOf(' ');
  return `“${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()}…”`;
}

// ---------------------------------------------------------------------------
// What ends with the hero's Concentration (srd:rule:concentration: "If the effect's creator loses Concentration, the
// effect ends"): the toggle or the chip's ×, damage to 0 HP, an Incapacitating condition, death by Exhaustion or by a
// Hit Point maximum of 0
// ---------------------------------------------------------------------------

/** The engine's event that ends the hero's Concentration (setConcentration, and its end at 0 HP, death or a condition). */
function endsConcentration(e: GameEvent): boolean {
  return e.type === 'condition-removed' && /^(?:Concentration on |No longer concentrating on )/.test(e.message);
}

/** What a sheet edit's engine result ended with the hero's Concentration. */
interface ConcentrationEnded {
  spell: string;
  /** Where the end starts among the engine's events: those before it are what the edit did first. */
  at: number;
  /** The engine's words from the end on: "Concentration on Bless ends (Unconscious)", "Shield of Faith ends: AC 14 → 12". */
  said: string[];
  /** Its warnings from the end on (an AC set by hand for the spell): the DM's, who can set the AC; the player can't. */
  forDm: string[];
  /** A warning before the end: still the player's. */
  toast?: string;
  /** The AC spell whose record ended with it (Shield of Faith on the hero, folded into the hero's Concentration). */
  acSpell?: string;
  /** The hero died with it: no spell protects the hero any more. */
  dead: boolean;
  /** The hero's own conditions that name the spell (their source or duration): the ones it may have imposed. */
  conditions: ConditionNaming[];
}

function concentrationEnded(before: Character, after: Character, events: readonly GameEvent[]): ConcentrationEnded | null {
  const spell = before.spellcasting?.concentratingOn?.trim();
  const now = after.spellcasting?.concentratingOn?.trim();
  if (!spell || (now && nameKey(now) === nameKey(spell))) return null;
  const at = Math.max(0, events.findIndex(endsConcentration));
  const from = events.slice(at);
  const kept = acSpells(after);
  return {
    spell,
    at,
    // A new Concentration (a switch's "Concentrating on Detect Magic.") is the notice's own words.
    said: from.filter((e) => e.type !== 'warning' && e.type !== 'condition-added').map((e) => e.message.trim().replace(/\.$/, '')),
    forDm: from.filter((e) => e.type === 'warning').map((e) => e.message.replace(/\s+/g, ' ').trim()),
    toast: firstWarning(events.slice(0, at)),
    acSpell: acSpells(before).find((n) => !kept.includes(n)),
    dead: after.deathSaves.dead,
    // The sheet sees no fight: the hero's conditions alone (the DM's tools name a combatant's).
    conditions: conditionsNaming(spell, after, null),
  };
}

/**
 * "Mira Voss is Invisible (source: Invisibility)": a condition that names the ended spell, and the field that names
 * it, as the DM's tools word it (a homebrew one `has "Glowing"`), on one line. The source may name the spell without
 * its note, as conditionsNaming reads it ("Invisibility" for a sheet copy's "Invisibility (scroll)").
 */
function conditionNamingText(n: ConditionNaming, spell: string): string {
  const { id, source, duration } = n.condition;
  const standard = matchStandardCondition(id);
  const state = standard && standard.id === conditionKey(id) ? `is ${conditionName(id)}` : `has "${id.trim()}"`;
  const detail = namesSpell(source, spell) ? `source: ${source?.trim()}` : `duration: ${duration?.trim() ?? ''}`;
  return `${n.who} ${state} (${detail})`.replace(/\s+/g, ' ');
}

/**
 * A notice with what ended with the hero's Concentration, on its one line: the engine's words (but the end itself when
 * the notice already says it), a hint to record a Shield of Faith that still protects a living hero again (the sheet
 * can't tell the hero's own casting from another caster's), each of the hero's conditions that names the spell, with
 * the call that removes it, one conditional clause for an area the spell may have left (Shield of Faith and Mage Armor
 * leave none, a sheet copy's "Shield of Faith (scroll)" included), named by the spell without its note (a sheet copy's
 * "Hold Person (scroll)" leaves an area labelled "Hold Person"), then the reminder about an AC set by hand for the
 * spell. The sheet can't see the map, so it can't tell the hero's area from another caster's of the same name: the
 * clause says the call ends every area of that name (RX4).
 */
function withConcentrationEnd(head: string, ended: ConcentrationEnded, { endSaid }: { endSaid: boolean }): string {
  const clauses = endSaid ? ended.said.slice(1) : [...ended.said];
  if (ended.acSpell && !ended.dead) clauses.push(`if ${ended.acSpell} still protects the hero, record it again with ac_spells_add`);
  for (const n of ended.conditions) {
    clauses.push(`${conditionNamingText(n, ended.spell)}: if the spell caused it, remove it with update_character conditions_remove`);
  }
  if (!acSpellNamed(ended.spell)) {
    clauses.push(`if it left an area on the map, end it with update_map effects_end ${JSON.stringify([withoutNote(ended.spell)])} (it ends every area of that name)`);
  }
  return `${[head, ...clauses].join('; ')}${ended.forDm.length ? ` — ${ended.forDm.join(' ')}` : ''}`;
}

// ---------------------------------------------------------------------------
// Hit points, death saves, exhaustion, inspiration, concentration
// ---------------------------------------------------------------------------

function hpText(c: Character): string {
  return `${c.hp.current}${c.hp.temp ? ` (+${c.hp.temp} temp)` : ''}`;
}

/**
 * Damage from the sheet. Dropping to 0 HP (or dying) ends the hero's Concentration (srd:rule:concentration: "Your
 * Concentration ends if you have the Incapacitated condition or you die"), and the DM hears what ended with it.
 */
export function damageChange(c: Character, amount: number): SheetChange {
  if (!(amount > 0)) return unchanged(c);
  const { character, events } = applyDamage(c, amount);
  const warn = firstWarning(events);
  if (character === c) return unchanged(c, warn);
  const down = character.hp.current === 0 && c.hp.current > 0 ? ' — dropped to 0 HP' : '';
  const notice = `Player changed HP ${hpText(c)} → ${hpText(character)} (${amount} damage)${down}`;
  const ended = concentrationEnded(c, character, events);
  if (!ended) return { character, notice, warning: warn };
  return { character, notice: withConcentrationEnd(notice, ended, { endSaid: false }), warning: ended.toast };
}

export function healChange(c: Character, amount: number): SheetChange {
  if (!(amount > 0)) return unchanged(c);
  const { character, events } = applyHealing(c, amount);
  const warn = firstWarning(events);
  if (character.hp.current === c.hp.current) return unchanged(character === c ? c : character, warn ?? 'Already at full HP.');
  return { character, notice: `Player changed HP ${c.hp.current} → ${character.hp.current} (healed ${amount})`, warning: warn };
}

export function tempHpChange(c: Character, amount: number): SheetChange {
  if (!(amount >= 0)) return unchanged(c);
  if (amount === 0) {
    if (!c.hp.temp) return unchanged(c);
    return { character: { ...c, hp: { ...c.hp, temp: 0 } }, notice: `Player cleared temporary HP (${c.hp.temp} → 0)` };
  }
  const { character } = setTempHp(c, amount);
  if (character.hp.temp === c.hp.temp) return unchanged(c, `Temporary HP don't stack — you keep ${c.hp.temp}.`);
  return { character, notice: `Player set temporary HP ${c.hp.temp} → ${character.hp.temp}` };
}

/** Exhaustion from the sheet. Level 6 is death (srd:condition:exhaustion), which ends Concentration as damage can. */
export function exhaustionChange(c: Character, level: number): SheetChange {
  const target = Math.max(0, Math.min(6, level));
  if (target === c.exhaustion) return unchanged(c);
  const { character, events } = changeExhaustion(c, target - c.exhaustion);
  const notice = `Player changed exhaustion ${c.exhaustion} → ${character.exhaustion}`;
  const ended = concentrationEnded(c, character, events);
  if (!ended) return { character, notice, warning: firstWarning(events) };
  return { character, notice: withConcentrationEnd(notice, ended, { endSaid: false }), warning: ended.toast };
}

export function inspirationChange(c: Character, value: boolean): SheetChange {
  if (c.heroicInspiration === value) return unchanged(c);
  return { character: { ...c, heroicInspiration: value }, notice: value ? 'Player gained Heroic Inspiration' : 'Player spent Heroic Inspiration' };
}

/**
 * Start (a spell's name) or end (null) the hero's Concentration: the Spells tab's toggle, the chip's ×. The engine's
 * refusal (the dead, an Incapacitated hero) changes nothing, so the DM hears nothing and its words are the player's;
 * an end tells the DM what ended with it (srd:rule:concentration).
 */
export function concentrationChange(c: Character, spellName: string | null): SheetChange {
  const current = c.spellcasting?.concentratingOn ?? null;
  if (current === spellName) return unchanged(c);
  const { character, events } = setConcentration(c, spellName);
  // A refusal, or the same spell under another spelling.
  if (character === c) return unchanged(c, firstWarning(events));
  const now = character.spellcasting?.concentratingOn ?? null;
  const notice = now === null ? `Player ended concentration on ${current}` : `Player is now concentrating on ${now}${current ? ` (ending ${current})` : ''}`;
  const ended = concentrationEnded(c, character, events);
  return { character, notice: ended ? withConcentrationEnd(notice, ended, { endSaid: true }) : notice };
}

/** The engine's messages on one line, warnings left out. */
function changeText(events: readonly GameEvent[]): string {
  return events
    .filter((e) => e.type !== 'warning')
    .map((e) => e.message.trim().replace(/\.$/, ''))
    .join('; ');
}

/**
 * The player's Hit Point maximum change (HpMaxDialog): an effect such as Aid or Life Drain, or a lasting change. A
 * maximum of 0 is death (srd:rule:damage-and-healing-dropping-to-0-hit-points-instant-death: "A creature dies if its
 * Hit Point maximum reaches 0"), which ends the hero's Concentration: the DM hears what ended with it, the reminder
 * about an AC set by hand included, as from the sheet's other ends.
 */
export function hpMaxChange(c: Character, spec: HpMaxChange): SheetChange {
  const { character, events } = adjustHpMax(c, spec);
  if (character === c) return unchanged(c, firstWarning(events));
  const said = (shown: readonly GameEvent[]) => `Player changed their Hit Point maximum: ${changeText(shown)}`;
  const ended = concentrationEnded(c, character, events);
  // The death comes first: what ended with it follows, as the other paths tell it.
  if (!ended || ended.at === 0) return { character, notice: said(events) };
  return { character, notice: withConcentrationEnd(said(events.slice(0, ended.at)), ended, { endSaid: false }), warning: ended.toast };
}

/**
 * The player ends an adjustment (its × on the Hit Points bar). Ending a raise (Aid) can leave a maximum of 0, which is
 * death as in hpMaxChange (srd:rule:damage-and-healing-dropping-to-0-hit-points-instant-death: "A creature dies if its
 * Hit Point maximum reaches 0") and ends the hero's Concentration: the DM hears what ended with it in the same words,
 * the reminder about an AC set by hand included, and the player gets no toast of the DM's.
 */
export function endHpMaxChange(c: Character, name: string, ends?: HpMaxEnds): SheetChange {
  const { character, events } = endHpMaxAdjustments(c, name, ends);
  if (character === c) return unchanged(c, firstWarning(events));
  const said = (shown: readonly GameEvent[]) => `Player ended a Hit Point maximum adjustment: ${changeText(shown)}`;
  const ended = concentrationEnded(c, character, events);
  // The death comes first: what ended with it follows, as the other paths tell it.
  if (!ended || ended.at === 0) return { character, notice: said(events), warning: firstWarning(events) };
  return { character, notice: withConcentrationEnd(said(events.slice(0, ended.at)), ended, { endSaid: false }), warning: ended.toast };
}

/**
 * The player ends an AC spell (its chip's × under the stat tiles): Mage Armor, or another caster's Shield of Faith; the
 * AC follows (the engine's endAcSpell). An AC the app can't settle alone (one set by hand that may count the spell) is
 * kept: the DM, whose call it is, reads the engine's words on the notice's line, and the player, who can't set the AC
 * on the sheet, gets a plain toast.
 */
export function endAcSpellChange(c: Character, name: string, catalog: EquipmentOption[] | null = null): SheetChange {
  const { character, events } = endAcSpell(c, name, catalog ?? []);
  const warning = firstWarning(events);
  if (character === c) return unchanged(c, warning);
  const ac = character.armorClass === c.armorClass ? `AC stays ${c.armorClass}` : `AC ${c.armorClass} → ${character.armorClass}`;
  return {
    character,
    notice: `Player ended ${acSpellNamed(name) ?? name} (${ac})${warning ? ` — ${warning.replace(/\s+/g, ' ')}` : ''}`,
    warning: warning ? `Your AC stays ${character.armorClass}: the app can't settle it on its own, so your DM will be told with your next message.` : undefined,
  };
}

export function deathSaveMarkChange(c: Character, kind: 'successes' | 'failures', count: number): SheetChange {
  const value = Math.max(0, Math.min(3, count));
  if (c.deathSaves[kind] === value) return unchanged(c);
  // A living hero always has a maximum; one of 0 is death (SRD 5.2.1 Instant Death), until what lowered it ends.
  if (kind === 'failures' && c.deathSaves.dead && value < 3 && c.hp.max <= 0) {
    return unchanged(c, "Your hero's Hit Point maximum is 0: end what lowered it first (its × on the Hit Points bar).");
  }
  const deathSaves = {
    ...c.deathSaves,
    [kind]: value,
    stable: kind === 'successes' ? value >= 3 : c.deathSaves.stable,
    dead: kind === 'failures' ? value >= 3 : c.deathSaves.dead,
  };
  const label = kind === 'successes' ? 'successes' : 'failures';
  return { character: { ...c, deathSaves }, notice: `Player set death save ${label} ${c.deathSaves[kind]} → ${value}` };
}

export function deathSaveRollChange(c: Character, natural: number, total: number): SheetChange {
  const result = recordDeathSave(c, natural);
  const { successes, failures } = result.character.deathSaves;
  const summary =
    result.outcome === 'revived'
      ? 'natural 20 — regains 1 HP'
      : result.outcome === 'dead'
        ? 'three failures — the character dies'
        : result.outcome === 'stable'
          ? 'three successes — stable'
          : `${result.outcome} (${successes} successes, ${failures} failures)`;
  return { character: result.character, notice: `Player rolled a death saving throw: ${total} — ${summary}` };
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/**
 * A condition from the sheet. An Incapacitating one ends the hero's Concentration (srd:condition:incapacitated: "Your
 * Concentration is broken"), and the DM hears what ended with it. The engine's refusal (the dead, an immunity) changes
 * nothing: its words are the player's, and the DM hears nothing.
 */
export function addConditionChange(c: Character, conditionId: string): SheetChange {
  if (c.conditions.some((x) => x.id === conditionId)) return unchanged(c);
  const { character, events } = addCondition(c, { id: conditionId, source: 'Player' });
  if (character === c) return unchanged(c, firstWarning(events));
  const notice = `Player added the ${conditionName(conditionId)} condition`;
  const ended = concentrationEnded(c, character, events);
  if (!ended) return { character, notice };
  return { character, notice: withConcentrationEnd(notice, ended, { endSaid: false }), warning: ended.toast };
}

export function removeConditionChange(c: Character, conditionId: string): SheetChange {
  if (!c.conditions.some((x) => x.id === conditionId)) return unchanged(c);
  const { character } = removeCondition(c, conditionId);
  return { character, notice: `Player removed the ${conditionName(conditionId)} condition` };
}

// ---------------------------------------------------------------------------
// Spell slots, prepared spells, feature uses
// ---------------------------------------------------------------------------

export function slotChange(c: Character, level: SpellSlotLevel, spend: boolean, pact = false): SheetChange {
  const result = spend ? spendSlot(c, level, { pact }) : restoreSlot(c, level, 1, { pact });
  const warn = firstWarning(result.events);
  if (result.character === c) return unchanged(c, warn);
  const sc = result.character.spellcasting;
  const track = pact ? sc?.pact?.slots : sc?.slots[level];
  const left = track ? ` (${track.max - track.used}/${track.max} left)` : '';
  const what = pact ? `a Pact Magic slot (level ${level})` : `a ${ordinal(level)}-level slot`;
  return { character: result.character, notice: spend ? `Player marked ${what} as used${left}` : `Player restored ${what}${left}` };
}

export function preparedChange(c: Character, spellId: string, prepared: boolean): SheetChange {
  const sc = c.spellcasting;
  const spell = sc?.spells.find((s) => s.id === spellId);
  if (!sc || !spell || spell.prepared === prepared || spell.alwaysPrepared) return unchanged(c);
  const spells = sc.spells.map((s) => (s.id === spellId ? { ...s, prepared } : s));
  return { character: { ...c, spellcasting: { ...sc, spells } }, notice: `Player ${prepared ? 'prepared' : 'unprepared'} ${spell.name}` };
}

// ---------------------------------------------------------------------------
// Spell choices: a level's picks, skipping them, a Long Rest's change (SRD 5.2.1, each class's Spellcasting)
// ---------------------------------------------------------------------------

/** A spell's name for the DM, a book's followed by its title as feats' are: "Ashen Choir (The Gloamwood Almanac)". */
function spellNoticeName(spell: Pick<KnownSpell, 'name' | 'ref'>): string {
  return spell.ref ? `${spell.name} (${spell.ref.sourceTitle})` : spell.name;
}

const spellNames = (spells: readonly Pick<KnownSpell, 'name' | 'ref'>[]) => spells.map(spellNoticeName).join(', ');

/** The sheet spell for a class's pick: the class's name as its source (so its count sees it), never always prepared. */
function classSpell(spell: KnownSpell, source: string, prepared: boolean): KnownSpell {
  const { alwaysPrepared: _always, ...rest } = spell;
  return { ...rest, source, prepared };
}

/**
 * The picks a sheet can still take, in order: a name it holds is left out (adding it would merge into that entry, a
 * species' cantrip or the DM's grant), as is a second pick of one name; `ok` checks each pick's level.
 */
function freshPicks(c: Character) {
  const held = new Set((c.spellcasting?.spells ?? []).map((s) => nameKey(s.name)));
  return (spells: readonly KnownSpell[], ok: (s: KnownSpell) => boolean): KnownSpell[] =>
    spells.filter((s) => {
      const key = nameKey(s.name);
      if (!key || held.has(key) || !ok(s)) return false;
      held.add(key);
      return true;
    });
}

/** What the player chose in the choices form for one class's open level (sheet spells built from rules-index entries). */
export interface SpellPicksChoice {
  classId: string;
  /** New cantrips from the class's list. With `giveUpCantrip`, the last of them replaces it. */
  cantrips: readonly KnownSpell[];
  /** A spellbook's new spells (a Wizard's): prepared only when `prepare` names them too. */
  spellbook: readonly KnownSpell[];
  /** New prepared spells from the class's list (a class without a spellbook). With `giveUpSpell`, the last replaces it. */
  prepared: readonly KnownSpell[];
  /** A spellbook's spells to prepare, by id: its unprepared entries on the sheet and this choice's new book spells. */
  prepare: readonly string[];
  /** One of the class's cantrips given up, by id (the level allows replacing one). */
  giveUpCantrip?: string | null;
  /** One of the class's prepared level 1+ spells given up, by id (the level allows replacing one). */
  giveUpSpell?: string | null;
}

/**
 * The player's choices for a class's open level (SRD 5.2.1, each class's Spellcasting: "choose additional spells … until
 * the number of spells on your list matches the number on the table"), checked against the sheet as it is now (the
 * edit runs on the latest character): a pick whose name the sheet now holds is dropped, as is a spell given up that is
 * gone or isn't on the list (unprepared: giving it up frees no place), and each list takes no more than the table still
 * has room for; a spellbook's spells each fit the limit of the level they belong to (bookCaps). New spells have the
 * class's name as their source and are prepared; a Wizard's new spellbook spells only when also chosen to prepare. A
 * spell given up is removed by id and its replacement added in its place; a Concentration on it goes on (with a Shield
 * of Faith's +2), for replacing a prepared spell isn't among what breaks Concentration (srd:rule:concentration: "The
 * following factors break Concentration": Another Concentration Effect, Damage, Incapacitated or Dead). The class's
 * choices close once nothing is owed; otherwise they stay open without the level's swaps.
 */
export function spellPicksChange(c: Character, cls: ClassOption, choice: SpellPicksChoice): SheetChange {
  const cl = c.classes.find((x) => x.classId === choice.classId);
  const owed = cl ? owedSpells(c, cl, cls) : null;
  if (!cl || !owed) return unchanged(c, "That class's spells can't be chosen on the sheet.");
  const entry = c.spellcasting?.spellPicks?.find((p) => p.classId === cl.classId);
  const own = classSpellsOf(c, cl.name);
  const fresh = freshPicks(c);
  const inRange = (s: KnownSpell) => s.level >= 1 && s.level <= owed.maxLevel;
  const giveUpCantrip = entry?.replaceCantrip ? own.find((s) => s.id === choice.giveUpCantrip && s.level === 0) : undefined;
  const giveUpSpell = entry?.replaceSpell && !owed.spellbook ? swappableSpells(c, cl.name, owed.maxLevel).find((s) => s.id === choice.giveUpSpell) : undefined;
  const cantrips = owed.cantrips ? fresh(choice.cantrips, (s) => s.level === 0).slice(0, owed.cantrips.owed + (giveUpCantrip ? 1 : 0)) : [];
  const book: KnownSpell[] = [];
  if (owed.spellbook) {
    for (const s of fresh(choice.spellbook, inRange)) {
      if (book.length < owed.spellbook.owed && fitsBookCaps([...book, s].map((x) => x.level), owed.bookCaps)) book.push(s);
    }
  }
  const prepared = owed.spellbook ? [] : fresh(choice.prepared, inRange).slice(0, owed.prepared.owed + (giveUpSpell ? 1 : 0));
  // A spellbook's spells to prepare: its unprepared entries (extras too) of a level it has slots for, and the new ones.
  const preparable = new Map<string, Pick<KnownSpell, 'name' | 'ref'>>([
    ...(owed.spellbook ? bookSpellsOf(c, cl.name) : []).filter((s) => inRange(s) && !s.prepared).map((s) => [s.id, s] as const),
    ...book.map((s) => [s.id, s] as const),
  ]);
  const prepare = owed.spellbook ? [...new Set(choice.prepare)].filter((id) => preparable.has(id)).slice(0, owed.prepared.owed) : [];
  // A swap needs its replacement: the last pick of its list.
  const cantripSwap = giveUpCantrip && cantrips.length ? { out: giveUpCantrip, in: cantrips[cantrips.length - 1] } : null;
  const spellSwap = giveUpSpell && prepared.length ? { out: giveUpSpell, in: prepared[prepared.length - 1] } : null;
  if (!cantrips.length && !book.length && !prepared.length && !prepare.length) {
    return unchanged(c, 'Nothing changed: those spells are on your sheet already, or no longer yours to choose.');
  }

  let next = c;
  for (const swap of [cantripSwap, spellSwap]) if (swap) next = removeSpellById(next, swap.out.id, { keepConcentration: true }).character;
  for (const s of cantrips) next = addSpell(next, classSpell(s, cl.name, true)).character;
  for (const s of book) next = addSpell(next, classSpell(s, cl.name, prepare.includes(s.id))).character;
  for (const s of prepared) next = addSpell(next, classSpell(s, cl.name, true)).character;
  const fromBook = new Set(prepare.filter((id) => !book.some((s) => s.id === id)));
  if (fromBook.size && next.spellcasting) {
    next = { ...next, spellcasting: { ...next.spellcasting, spells: next.spellcasting.spells.map((s) => (fromBook.has(s.id) ? { ...s, prepared: true } : s)) } };
  }
  const levelled = next.classes.find((x) => x.classId === cl.classId) ?? cl;
  const after = owedSpells(next, levelled, cls);
  // What is left, with the spellbook's limits by level: the DM may record what the player names later.
  const remaining = after ? owedSpellsSummary(after, true) : '';
  next = remaining ? withoutSwaps(next, cl.classId) : closeSpellPicks(next, cl.classId);

  const parts: string[] = [];
  const newCantrips = cantripSwap ? cantrips.slice(0, -1) : cantrips;
  if (newCantrips.length) parts.push(`${newCantrips.length === 1 ? 'cantrip' : 'cantrips'} ${spellNames(newCantrips)}`);
  if (book.length) parts.push(`spellbook ${spellNames(book)}`);
  const preparedNow = owed.spellbook ? prepare.map((id) => preparable.get(id)!) : spellSwap ? prepared.slice(0, -1) : prepared;
  if (preparedNow.length) parts.push(`prepared ${spellNames(preparedNow)}`);
  for (const swap of [cantripSwap, spellSwap]) if (swap) parts.push(`replaced ${spellNoticeName(swap.out)} with ${spellNoticeName(swap.in)}`);
  if (remaining) parts.push(`still to choose: ${remaining}`);
  return { character: next, notice: `Player chose spells for ${cl.name} ${cl.level}: ${parts.join('; ')}` };
}

/** The player leaves a class's open choices: they close, and the DM hears what wasn't chosen. */
export function skipSpellPicksChange(c: Character, cls: ClassOption | undefined, classId: string): SheetChange {
  const cl = c.classes.find((x) => x.classId === classId);
  const next = closeSpellPicks(c, classId);
  if (!cl || next === c) return unchanged(c);
  const owed = cls ? owedSpells(c, cl, cls) : null;
  const summary = owed ? owedSpellsSummary(owed) : '';
  return { character: next, notice: `Player skipped their spell choices for ${cl.name} ${cl.level} (${summary ? `not chosen: ${summary}` : 'kept their spells'})` };
}

/** What the player changes after a Long Rest, for one class: each spell given up is replaced by the pick at its place. */
export interface RestSpellChange {
  classId: string;
  /** The class's prepared level 1+ spells given up, by id. */
  giveUp: readonly string[];
  /** Their replacements from the class's list, in the same order. */
  picks: readonly KnownSpell[];
  /** One of the class's cantrips given up, by id (the Wizard's), and its replacement. */
  giveUpCantrip?: string | null;
  cantrip?: KnownSpell | null;
}

/**
 * The changes a Long Rest allows the class (its own Spellcasting text, classSpellRules): a Cleric or Druid replaces any
 * of its prepared spells ("replacing any of the spells there with other Cleric spells for which you have spell slots"),
 * a Paladin or Ranger one ("you can replace one spell on your list"), a Wizard one of its cantrips (its prepared spells
 * change with the sheet's checkboxes, from its spellbook). Always one for one, so the class's count never changes;
 * nothing records when the rest happened, so the DM hears of it and can object. A Concentration on a spell given up
 * goes on, as in spellPicksChange (srd:rule:concentration).
 */
export function restSpellChange(c: Character, cls: ClassOption, change: RestSpellChange): SheetChange {
  const cl = c.classes.find((x) => x.classId === change.classId);
  if (!cl) return unchanged(c);
  const rules = classSpellRules(cls).longRest;
  const cap = classSpellLevelCap(cl);
  const own = classSpellsOf(c, cl.name);
  const listed = swappableSpells(c, cl.name, cap);
  const fresh = freshPicks(c);
  const pairs: [KnownSpell, KnownSpell][] = [];
  if (rules.spells && !rules.fromSpellbook) {
    const out = [...new Set(change.giveUp)].flatMap((id) => listed.filter((s) => s.id === id));
    const ins = fresh(change.picks, (s) => s.level >= 1 && s.level <= cap);
    const count = Math.min(out.length, ins.length, rules.spells === 'one' ? 1 : Infinity);
    for (let i = 0; i < count; i++) pairs.push([out[i], ins[i]]);
  }
  const spellPairs = pairs.length;
  if (rules.cantrip) {
    const out = own.find((s) => s.id === change.giveUpCantrip && s.level === 0);
    const [replacement] = change.cantrip ? fresh([change.cantrip], (s) => s.level === 0) : [];
    if (out && replacement) pairs.push([out, replacement]);
  }
  if (!pairs.length) return unchanged(c, 'Nothing changed: choose a spell to give up and one to take its place.');
  let next = c;
  for (const [out, replacement] of pairs) {
    next = removeSpellById(next, out.id, { keepConcentration: true }).character;
    next = addSpell(next, classSpell(replacement, cl.name, true)).character;
  }
  const what = [spellPairs ? 'prepared spells' : '', pairs.length > spellPairs ? 'cantrips' : ''].filter(Boolean).join(' and ');
  const text = pairs.map(([out, replacement]) => `${spellNoticeName(out)} → ${spellNoticeName(replacement)}`).join(', ');
  return { character: next, notice: `Player changed their ${cl.name} ${what} (allowed after a Long Rest): ${text}` };
}

export function featureUseChange(c: Character, featureId: string, spend: boolean): SheetChange {
  const feature = c.features.find((f) => f.id === featureId);
  const uses = feature?.uses;
  if (!feature || !uses) return unchanged(c);
  const used = Math.max(0, Math.min(uses.max, uses.used + (spend ? 1 : -1)));
  if (used === uses.used) return unchanged(c, spend ? `No uses of ${feature.name} left.` : undefined);
  const features = c.features.map((f) => (f.id === featureId ? { ...f, uses: { ...uses, used } } : f));
  const left = `${uses.max - used}/${uses.max} left`;
  return {
    character: { ...c, features },
    notice: spend ? `Player used ${feature.name} (${left})` : `Player restored a use of ${feature.name} (${left})`,
  };
}

// ---------------------------------------------------------------------------
// Inventory & coins
// ---------------------------------------------------------------------------

/**
 * Keep AC in step with gear: armor and shields, and also items such as a Ring or Cloak of Protection
 * or Bracers of Defense. syncArmorClass keeps an AC set by hand (Haste...) and falls back to the
 * SRD armor table when the catalog hasn't loaded. Its warning (an AC set by hand kept while gear now gives
 * another, or armor whose stats are unknown) is the player's toast and ends the DM's notice: nothing else
 * tells either of them the AC may now be wrong, and the ruling is the DM's.
 */
function withAc(
  before: Character,
  after: Character,
  catalog: EquipmentOption[] | null,
  also: (synced: Character) => string | null = () => null,
): { character: Character; acNote: string; warning?: string } {
  const { character, events } = syncArmorClass(before, after, catalog ?? []);
  // And what every save includes (a Cloak of Protection, an item's bonus the app read), when that changed too.
  const saves = saveSourcesChangeText(before, character);
  const notes = [character.armorClass === before.armorClass ? '' : `AC ${before.armorClass} → ${character.armorClass}`, saves ? saves.replace(/^S/, 's') : ''].filter(Boolean);
  const warning = firstWarning(events);
  // The DM, whose call it is, reads the engine's words on the notice's one line (notices are parsed back line by line;
  // the AC formula it quotes names other items too), and then anything else it should know (`also`). The player can't
  // set the AC on the sheet, so their toast only says what happened and who decides.
  const said = [warning?.replace(/\s+/g, ' '), also(character)].filter(Boolean);
  const kept = said.length ? ` — ${said.join(' ')}` : '';
  const toast = warning ? `Your AC stays ${character.armorClass}: your gear alone can't settle it, so your DM will be told with your next message.` : undefined;
  return { character, acNote: `${notes.length ? ` (${notes.join('; ')})` : ''}${kept}`, warning: toast };
}

/**
 * Armor put on while Mage Armor is recorded (srd:spell:mage-armor: "The spell ends early if the target dons armor"):
 * the sheet's toggle is bookkeeping, not donning (srd:rule:armor: even Light Armor takes a minute to don), so the spell
 * isn't ended; it just isn't counted while armor is worn, and the DM, who knows, can end it. Armor is the item's
 * category or numbers, or Mage Armor no longer counted (armor known only by its name).
 */
function mageArmorWhileArmored(before: Character, after: Character, item: InventoryItem): string | null {
  if (!acSpells(after).includes('Mage Armor')) return null;
  const armor = item.armor ? item.armor.kind === 'armor' : item.category === 'armor';
  const displaced = countedAcSpells(before).includes('Mage Armor') && !countedAcSpells(after).includes('Mage Armor');
  if (!armor && !displaced) return null;
  const who = after.name.trim() || 'the hero';
  return `Mage Armor isn't counted while ${who} wears armor: if ${who} really put it on, end it with ac_spells_end ["Mage Armor"].`;
}

function mapItem(c: Character, itemId: string, patch: Partial<InventoryItem>): Character {
  return { ...c, inventory: c.inventory.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) };
}

/**
 * Change a stack's size. It never goes below 1: taking an item off the sheet loses its details, so
 * that is removeItemChange, behind the sheet's "Remove?" confirmation.
 */
export function itemQuantityChange(c: Character, itemId: string, quantity: number): SheetChange {
  const item = c.inventory.find((i) => i.id === itemId);
  if (!item || !Number.isFinite(quantity)) return unchanged(c);
  const qty = Math.floor(quantity);
  if (qty < 1) return unchanged(c, `Use Remove to take ${item.name} off your sheet.`);
  if (qty === item.quantity) return unchanged(c);
  return { character: mapItem(c, itemId, { quantity: qty }), notice: `Player changed ${item.name} quantity ${item.quantity} → ${qty}` };
}

export function itemEquipChange(c: Character, itemId: string, equipped: boolean, catalog: EquipmentOption[] | null): SheetChange {
  const item = c.inventory.find((i) => i.id === itemId);
  if (!item || Boolean(item.equipped) === equipped) return unchanged(c);
  let next = mapItem(c, itemId, { equipped });
  // Only one suit of armor and one shield at a time.
  if (equipped && (item.category === 'armor' || item.category === 'shield')) {
    next = { ...next, inventory: next.inventory.map((i) => (i.id !== itemId && i.category === item.category && i.equipped ? { ...i, equipped: false } : i)) };
  }
  const { character, acNote, warning } = withAc(c, next, catalog, (synced) => (equipped ? mageArmorWhileArmored(c, synced, item) : null));
  return { character, notice: `Player ${equipped ? 'equipped' : 'unequipped'} ${item.name}${acNote}`, warning };
}

export const MAX_ATTUNED = 3;

export function itemAttuneChange(
  c: Character,
  itemId: string,
  attuned: boolean,
  catalog: EquipmentOption[] | null = null,
): SheetChange {
  const item = c.inventory.find((i) => i.id === itemId);
  if (!item || Boolean(item.attuned) === attuned) return unchanged(c);
  const count = c.inventory.filter((i) => i.attuned).length;
  if (attuned && count >= MAX_ATTUNED) return unchanged(c, `You can be attuned to at most ${MAX_ATTUNED} magic items.`);
  const { character, acNote, warning } = withAc(c, mapItem(c, itemId, { attuned }), catalog);
  return {
    character,
    notice: `${attuned ? `Player attuned to ${item.name}` : `Player ended attunement to ${item.name}`}${acNote}`,
    warning,
  };
}

/** Taking worn armor, a Shield or an attuned protection item off the sheet changes the AC as unequipping it would. */
export function removeItemChange(c: Character, itemId: string, catalog: EquipmentOption[] | null = null): SheetChange {
  const item = c.inventory.find((i) => i.id === itemId);
  if (!item) return unchanged(c);
  const { character, acNote, warning } = withAc(c, { ...c, inventory: c.inventory.filter((i) => i.id !== itemId) }, catalog);
  return {
    character,
    notice: `Player removed ${item.name}${item.quantity > 1 ? ` ×${item.quantity}` : ''} from their inventory${acNote}`,
    warning,
  };
}

export function addItemChange(c: Character, item: InventoryItem): SheetChange {
  const name = item.name.trim();
  if (!name || item.quantity < 1) return unchanged(c);
  return {
    character: { ...c, inventory: [...c.inventory, { ...item, name }] },
    notice: `Player added ${name}${item.quantity > 1 ? ` ×${item.quantity}` : ''} to their inventory`,
  };
}

const COINS: (keyof Currency)[] = ['pp', 'gp', 'ep', 'sp', 'cp'];

export function currencyChange(c: Character, next: Currency): SheetChange {
  const parts = COINS.filter((k) => c.currency[k] !== next[k]).map((k) => `${c.currency[k]} → ${next[k]} ${k}`);
  if (!parts.length) return unchanged(c);
  return { character: { ...c, currency: { ...next } }, notice: `Player changed coins: ${parts.join(', ')}` };
}

// ---------------------------------------------------------------------------
// Personality & notes
// ---------------------------------------------------------------------------

export const PERSONALITY_LABELS: Record<keyof Personality, string> = {
  traits: 'Personality traits',
  ideals: 'Ideals',
  bonds: 'Bonds',
  flaws: 'Flaws',
  appearance: 'Appearance',
  backstory: 'Backstory',
};

/**
 * Under a field the DM's sheet can't carry whole (past SHEET_TEXT_MAX, where the sheet cuts it and tells the DM),
 * so the player knows: undefined for any real text.
 */
export function dmSheetLengthHint(text: string | undefined): string | undefined {
  return sheetCutsText(text)
    ? `The DM's sheet carries the first ${SHEET_TEXT_MAX.toLocaleString('en-US')} characters of this; past that it tells the DM the rest is left out.`
    : undefined;
}

/** The opening a personality notice quotes; past it, the notice says the whole text is on the sheet. */
const NOTICE_QUOTE = 60;

export function personalityChange(c: Character, field: keyof Personality, value: string): SheetChange {
  const text = value.trim();
  if ((c.personality[field] ?? '') === text) return unchanged(c);
  const personality = { ...c.personality, [field]: text || undefined };
  const label = PERSONALITY_LABELS[field].toLowerCase();
  // One line (notices are parsed back line by line): the opening, and where the DM reads the rest.
  const more = text.replace(/\s+/g, ' ').length > NOTICE_QUOTE ? ' (its opening; get_character_sheet has the whole text)' : '';
  return { character: { ...c, personality }, notice: text ? `Player updated their ${label}: ${quote(text, NOTICE_QUOTE)}${more}` : `Player cleared their ${label}` };
}

/** The same shape as a personality edit: the sheet carries the notes to the DM whole. */
export function notesChange(c: Character, value: string): SheetChange {
  if (c.notes === value) return unchanged(c);
  const text = value.trim();
  const more = text.replace(/\s+/g, ' ').length > NOTICE_QUOTE ? ' (its opening; get_character_sheet has the whole text)' : '';
  return {
    character: { ...c, notes: value },
    notice: text ? `Player updated their notes on the sheet: ${quote(text, NOTICE_QUOTE)}${more}` : 'Player cleared their notes on the sheet',
  };
}
