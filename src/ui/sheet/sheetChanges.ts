/**
 * Pure sheet edits: each returns the new character plus a concise notice for the DM
 * ("Player changed HP 12 → 15"). Rules changes go through '@/engine'.
 */
import {
  addCondition,
  applyDamage,
  applyHealing,
  changeExhaustion,
  syncArmorClass,
  conditionName,
  ordinal,
  recordDeathSave,
  removeCondition,
  restoreSlot,
  setConcentration,
  setTempHp,
  spendSlot,
} from '@/engine';
import type {
  Character,
  Currency,
  EquipmentOption,
  GameEvent,
  InventoryItem,
  Personality,
  SpellSlotLevel,
} from '@/types';
import type { SheetChange } from './useSheetActions';

const unchanged = (c: Character, warning?: string): SheetChange => ({ character: c, notice: null, warning: warning ?? null });

function firstWarning(events: GameEvent[]): string | undefined {
  return events.find((e) => e.type === 'warning')?.message;
}

function quote(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return `“${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}”`;
}

// ---------------------------------------------------------------------------
// Hit points, death saves, exhaustion, inspiration, concentration
// ---------------------------------------------------------------------------

function hpText(c: Character): string {
  return `${c.hp.current}${c.hp.temp ? ` (+${c.hp.temp} temp)` : ''}`;
}

export function damageChange(c: Character, amount: number): SheetChange {
  if (!(amount > 0)) return unchanged(c);
  const { character, events } = applyDamage(c, amount);
  const warn = firstWarning(events);
  if (character === c) return unchanged(c, warn);
  const down = character.hp.current === 0 && c.hp.current > 0 ? ' — dropped to 0 HP' : '';
  return { character, notice: `Player changed HP ${hpText(c)} → ${hpText(character)} (${amount} damage)${down}`, warning: warn };
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

export function exhaustionChange(c: Character, level: number): SheetChange {
  const target = Math.max(0, Math.min(6, level));
  if (target === c.exhaustion) return unchanged(c);
  const { character, events } = changeExhaustion(c, target - c.exhaustion);
  return { character, notice: `Player changed exhaustion ${c.exhaustion} → ${character.exhaustion}`, warning: firstWarning(events) };
}

export function inspirationChange(c: Character, value: boolean): SheetChange {
  if (c.heroicInspiration === value) return unchanged(c);
  return { character: { ...c, heroicInspiration: value }, notice: value ? 'Player gained Heroic Inspiration' : 'Player spent Heroic Inspiration' };
}

export function concentrationChange(c: Character, spellName: string | null): SheetChange {
  const current = c.spellcasting?.concentratingOn ?? null;
  if (current === spellName) return unchanged(c);
  const { character } = setConcentration(c, spellName);
  if (spellName === null) return { character, notice: `Player ended concentration on ${current}` };
  return { character, notice: `Player is now concentrating on ${spellName}${current ? ` (ending ${current})` : ''}` };
}

export function deathSaveMarkChange(c: Character, kind: 'successes' | 'failures', count: number): SheetChange {
  const value = Math.max(0, Math.min(3, count));
  if (c.deathSaves[kind] === value) return unchanged(c);
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

export function addConditionChange(c: Character, conditionId: string): SheetChange {
  if (c.conditions.some((x) => x.id === conditionId)) return unchanged(c);
  const { character } = addCondition(c, { id: conditionId, source: 'Player' });
  return { character, notice: `Player added the ${conditionName(conditionId)} condition` };
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
 * or Bracers of Defense. syncArmorClass keeps an AC set by hand (Mage Armor...) and falls back to the
 * SRD armor table when the catalog hasn't loaded.
 */
function withAc(before: Character, after: Character, catalog: EquipmentOption[] | null): { character: Character; acNote: string } {
  const { character } = syncArmorClass(before, after, catalog ?? []);
  if (character.armorClass === before.armorClass) return { character, acNote: '' };
  return { character, acNote: ` (AC ${before.armorClass} → ${character.armorClass})` };
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
  const { character, acNote } = withAc(c, next, catalog);
  return { character, notice: `Player ${equipped ? 'equipped' : 'unequipped'} ${item.name}${acNote}` };
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
  const { character, acNote } = withAc(c, mapItem(c, itemId, { attuned }), catalog);
  return {
    character,
    notice: `${attuned ? `Player attuned to ${item.name}` : `Player ended attunement to ${item.name}`}${acNote}`,
  };
}

export function removeItemChange(c: Character, itemId: string): SheetChange {
  const item = c.inventory.find((i) => i.id === itemId);
  if (!item) return unchanged(c);
  return {
    character: { ...c, inventory: c.inventory.filter((i) => i.id !== itemId) },
    notice: `Player removed ${item.name}${item.quantity > 1 ? ` ×${item.quantity}` : ''} from their inventory`,
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

export function notesChange(c: Character, value: string): SheetChange {
  if (c.notes === value) return unchanged(c);
  return { character: { ...c, notes: value }, notice: 'Player edited their private notes on the sheet' };
}
