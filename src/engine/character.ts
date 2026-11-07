/**
 * Character state transitions. Every function is pure: it returns a NEW Character plus
 * GameEvents describing what happened (used for log lines and DM tool results).
 * Functions never throw for game-rule problems (e.g. not enough gold); they return the
 * unchanged character with a 'warning' event instead. updatedAt is bumped on change.
 *
 * Rules follow SRD 5.2.1 "Damage and Healing" and the Rules Glossary.
 */
import type {
  Ability,
  ActiveCondition,
  Character,
  Currency,
  Feature,
  FeatureUses,
  GameEvent,
  InventoryItem,
  KnownSpell,
  Spellcasting,
} from '@/types';
import { nameKey, newId } from '@/lib/id';
import { CONDITIONS, INCAPACITATING_CONDITIONS, conditionKey, conditionName, matchStandardCondition } from './conditions';
import { levelForXp } from './progression';
import { abilityModifier, characterLevel, deathSaveModifier, exhaustionLevel, hasCondition, spellcastingAbility } from './rules';
import { clamp, formatInt, gameEvent, lookupProblem, matchByName, toInt, touch, warning } from './util';

export interface EngineResult {
  character: Character;
  events: GameEvent[];
}

function unchanged(c: Character, message: string): EngineResult {
  return { character: c, events: [warning(message)] };
}

const MINUS = '−';
const FRESH_DEATH_SAVES = { successes: 0, failures: 0, stable: false, dead: false } as const;

/** A blank level-1 character shell with sane defaults (used by the builder). */
export function createBlankCharacter(campaignId: string): Character {
  const now = Date.now();
  return {
    id: newId(),
    campaignId,
    name: '',
    species: '',
    background: '',
    classes: [],
    xp: 0,
    abilityScores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    savingThrows: [],
    skills: {},
    tools: [],
    languages: ['Common'],
    weaponProficiencies: [],
    armorTraining: [],
    weaponMasteries: [],
    armorClass: 10,
    acFormula: '10 + DEX 0',
    speed: 30,
    size: 'Medium',
    // HP come from the first class level (hit die + CON); the builder or levelUp fills them in.
    hp: { max: 0, current: 0, temp: 0 },
    hitDice: [],
    deathSaves: { ...FRESH_DEATH_SAVES },
    conditions: [],
    exhaustion: 0,
    heroicInspiration: false,
    features: [],
    attacks: [],
    inventory: [],
    currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
    personality: {},
    notes: '',
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Hit points, dying and death
// ---------------------------------------------------------------------------

/** Constitution save DC to keep Concentration after taking damage: max(10, half the damage), at most 30. */
export function concentrationSaveDC(damage: number): number {
  return clamp(Math.floor(Math.max(0, toInt(damage)) / 2), 10, 30);
}

function endConcentration(c: Character, reason: string): EngineResult {
  const spell = c.spellcasting?.concentratingOn;
  if (!c.spellcasting || !spell) return { character: c, events: [] };
  return {
    character: { ...c, spellcasting: { ...c.spellcasting, concentratingOn: null } },
    events: [gameEvent('condition-removed', `Concentration on ${spell} ends (${reason}).`)],
  };
}

function withCondition(conditions: readonly ActiveCondition[], condition: ActiveCondition): ActiveCondition[] {
  const key = conditionKey(condition.id);
  return conditions.some((x) => conditionKey(x.id) === key) ? [...conditions] : [...conditions, condition];
}

function withoutCondition(conditions: readonly ActiveCondition[], id: string): ActiveCondition[] {
  const key = conditionKey(id);
  return conditions.filter((x) => conditionKey(x.id) !== key);
}

/** Back above 0 HP: Unconscious ends (you remain Prone — SRD 5.2.1 Unconscious) and death saves reset. */
function revive(c: Character, current: number): Character {
  const conditions = withCondition(withoutCondition(c.conditions, 'unconscious'), { id: 'prone', source: 'Fell unconscious' });
  return { ...c, hp: { ...c.hp, current }, conditions, deathSaves: { ...FRESH_DEATH_SAVES } };
}

function die(c: Character, deathSaves: Character['deathSaves'], message: string): EngineResult {
  const ended = endConcentration({ ...c, hp: { ...c.hp, current: 0 }, deathSaves }, 'death');
  return { character: touch(ended.character), events: [gameEvent('died', message), ...ended.events] };
}

function damageLabel(amount: number, damageType?: string): string {
  return `${amount}${damageType?.trim() ? ` ${damageType.trim()}` : ''}`;
}

/** Damage while already at 0 HP: one death-save failure (two on a critical hit); massive damage kills. */
function damageAtZero(c: Character, amount: number, temp: number, label: string, critical: boolean): EngineResult {
  const added = critical ? 2 : 1;
  const failures = Math.min(3, c.deathSaves.failures + added);
  const base = { ...c, hp: { ...c.hp, temp } };
  if (amount >= c.hp.max) {
    return die(base, { ...c.deathSaves, failures, stable: false, dead: true }, `Took ${label} at 0 HP — at least the HP maximum (${c.hp.max}): dies instantly.`);
  }
  if (failures >= 3) {
    return die(base, { ...c.deathSaves, failures: 3, stable: false, dead: true }, `Took ${label} at 0 HP — third death save failure: dies.`);
  }
  const wasStable = c.deathSaves.stable ? ' No longer Stable.' : '';
  const character = touch({ ...base, deathSaves: { ...c.deathSaves, failures, stable: false } });
  const message = `Took ${label} at 0 HP — ${added} death save failure${added > 1 ? 's' : ''}${critical ? ' (critical hit)' : ''} (${failures}/3).${wasStable}`;
  return { character, events: [gameEvent('death-save', message)] };
}

/**
 * Apply damage (2024 rules): temporary HP absorb first; at 0 HP the character falls unconscious
 * (adds the Unconscious condition and resets death saves). Massive damage: if damage remaining
 * after reaching 0 HP is >= HP max, the character dies. Damage taken while already at 0 HP adds one
 * death-save failure (two if `critical`); three failures = dead. Damage at 0 HP that equals or exceeds
 * the HP max kills. Damage while concentrating emits a Concentration-check warning (DC from
 * concentrationSaveDC); dropping to 0 ends Concentration.
 */
export function applyDamage(
  c: Character,
  amount: number,
  opts: { critical?: boolean; damageType?: string } = {},
): EngineResult {
  const damage = Math.max(0, toInt(amount));
  if (damage === 0) return { character: c, events: [] };
  if (c.deathSaves.dead) return unchanged(c, 'Already dead — further damage has no effect.');

  const absorbed = Math.min(Math.max(0, c.hp.temp), damage);
  const temp = c.hp.temp - absorbed;
  const toHp = damage - absorbed;
  const label = damageLabel(damage, opts.damageType);
  const tempNote = absorbed ? `; ${absorbed} absorbed by temporary HP` : '';
  // RAW: damage absorbed by temporary HP is still damage taken, so it still costs a death save.
  if (c.hp.current <= 0) return damageAtZero(c, damage, temp, `${label} damage${absorbed ? ` (${absorbed} absorbed by temporary HP)` : ''}`, !!opts.critical);

  const remaining = c.hp.current - toHp;
  if (remaining > 0 || toHp === 0) {
    const character = touch({ ...c, hp: { ...c.hp, current: remaining, temp } });
    const events = [
      toHp === 0
        ? gameEvent('temp-hp', `Temporary HP ${c.hp.temp} → ${temp} (${label} absorbed)`)
        : gameEvent('hp-changed', `HP ${c.hp.current} → ${remaining} (${label}${tempNote})`),
    ];
    const spell = c.spellcasting?.concentratingOn;
    if (spell) events.push(warning(`Concentration check: DC ${concentrationSaveDC(damage)} Constitution saving throw to keep ${spell}.`));
    return { character, events };
  }

  const overflow = -remaining;
  const zeroed = { ...c, hp: { ...c.hp, current: 0, temp } };
  if (overflow >= c.hp.max) {
    return die(
      zeroed,
      { successes: 0, failures: 0, stable: false, dead: true },
      `HP ${c.hp.current} → 0 (${label}${tempNote}) — massive damage: ${overflow} left over is at least the HP maximum (${c.hp.max}). Dies instantly.`,
    );
  }
  const down: Character = {
    ...zeroed,
    conditions: withCondition(c.conditions, { id: 'unconscious', source: '0 Hit Points' }),
    deathSaves: { ...FRESH_DEATH_SAVES },
  };
  const ended = endConcentration(down, 'Unconscious');
  return {
    character: touch(ended.character),
    events: [
      gameEvent('dropped-to-zero', `HP ${c.hp.current} → 0 (${label}${tempNote}) — Unconscious. Death saving throws begin.`),
      ...ended.events,
    ],
  };
}

/** Heal (capped at HP max). Healing from 0 HP revives: removes Unconscious and resets death saves. Dead characters cannot be healed. */
export function applyHealing(c: Character, amount: number): EngineResult {
  const heal = Math.max(0, toInt(amount));
  if (heal === 0) return { character: c, events: [] };
  if (c.deathSaves.dead) {
    return unchanged(c, "Dead characters can't regain Hit Points — only magic such as Revivify or Raise Dead can bring them back.");
  }
  if (c.hp.current >= c.hp.max) return unchanged(c, `Already at full HP (${c.hp.current}/${c.hp.max}).`);
  const current = Math.min(c.hp.max, c.hp.current + heal);
  if (c.hp.current <= 0) {
    return {
      character: touch(revive(c, current)),
      events: [gameEvent('revived', `HP 0 → ${current} (healed ${heal}) — conscious again, but still Prone.`)],
    };
  }
  return {
    character: touch({ ...c, hp: { ...c.hp, current } }),
    events: [gameEvent('hp-changed', `HP ${c.hp.current} → ${current} (healed ${current - c.hp.current})`)],
  };
}

/** Temporary HP don't stack: keep the higher of current and new. */
export function setTempHp(c: Character, amount: number): EngineResult {
  const value = Math.max(0, toInt(amount));
  if (value === 0) return { character: c, events: [] };
  if (c.deathSaves.dead) return unchanged(c, "The dead can't gain temporary HP.");
  if (value <= c.hp.temp) {
    return {
      character: c,
      events: [gameEvent('temp-hp', `Kept ${c.hp.temp} temporary HP — temporary HP don't stack, and ${value} isn't higher.`)],
    };
  }
  const note = c.hp.current <= 0 ? " (temporary HP don't restore consciousness)" : '';
  return {
    character: touch({ ...c, hp: { ...c.hp, temp: value } }),
    events: [gameEvent('temp-hp', `Temporary HP ${c.hp.temp} → ${value}${note}`)],
  };
}

/** Remove all temporary HP (e.g. the effect that granted them ended). */
export function clearTempHp(c: Character): EngineResult {
  if (c.hp.temp <= 0) return { character: c, events: [] };
  return {
    character: touch({ ...c, hp: { ...c.hp, temp: 0 } }),
    events: [gameEvent('temp-hp', `Temporary HP ${c.hp.temp} → 0`)],
  };
}

type DeathSaveOutcome = 'success' | 'failure' | 'stable' | 'revived' | 'dead';

/**
 * Record a death saving throw from the natural d20 (2024): 10+ success, 9- failure, natural 1 = two
 * failures, natural 20 = regain 1 HP (revived). Three successes = stable (the tallies reset, SRD 5.2.1);
 * three failures = dead. A death save is a saving throw, so the Exhaustion penalty and always-on save
 * bonuses (see deathSaveModifier) apply to the total; naturals 1 and 20 are judged on the die alone.
 * Throws RangeError if `natural` isn't a whole number 1–20 (a caller bug, not a game event).
 */
export function recordDeathSave(c: Character, natural: number): EngineResult & { outcome: DeathSaveOutcome } {
  if (!Number.isInteger(natural) || natural < 1 || natural > 20) {
    throw new RangeError(`A death saving throw needs a natural d20 result from 1 to 20 (got ${String(natural)}).`);
  }
  if (c.deathSaves.dead) return { ...unchanged(c, 'Already dead — no more death saving throws.'), outcome: 'dead' };
  if (c.hp.current > 0) return { ...unchanged(c, `Not dying (HP ${c.hp.current}) — no death saving throw needed.`), outcome: 'stable' };
  if (c.deathSaves.stable) {
    return { ...unchanged(c, 'Stable — no death saving throws unless damaged again.'), outcome: 'stable' };
  }

  if (natural === 20) {
    return {
      character: touch(revive(c, 1)),
      events: [gameEvent('revived', 'Death save: natural 20 — regains 1 HP and is conscious again (still Prone).')],
      outcome: 'revived',
    };
  }
  const modifier = deathSaveModifier(c);
  const total = natural + modifier;
  const rolled = modifier ? `natural ${natural}, ${total} after modifiers` : `natural ${natural}`;
  const saves = c.deathSaves;

  if (natural !== 1 && total >= 10) {
    const successes = saves.successes + 1;
    if (successes >= 3) {
      return {
        character: touch({ ...c, deathSaves: { successes: 0, failures: 0, stable: true, dead: false } }),
        events: [gameEvent('stabilized', `Death save succeeded (${rolled}) — third success: Stable at 0 HP (still Unconscious).`)],
        outcome: 'stable',
      };
    }
    return {
      character: touch({ ...c, deathSaves: { ...saves, successes } }),
      events: [gameEvent('death-save', `Death save succeeded (${rolled}) — ${successes} success${successes > 1 ? 'es' : ''}, ${saves.failures} failure${saves.failures === 1 ? '' : 's'}.`)],
      outcome: 'success',
    };
  }

  const added = natural === 1 ? 2 : 1;
  const failures = Math.min(3, saves.failures + added);
  const why = natural === 1 ? 'natural 1 counts as two failures' : rolled;
  if (failures >= 3) {
    const result = die(c, { ...saves, failures: 3, stable: false, dead: true }, `Death save failed (${why}) — third failure: dies.`);
    return { ...result, outcome: 'dead' };
  }
  return {
    character: touch({ ...c, deathSaves: { ...saves, failures } }),
    events: [gameEvent('death-save', `Death save failed (${why}) — ${saves.successes} success${saves.successes === 1 ? '' : 'es'}, ${failures} failure${failures > 1 ? 's' : ''}.`)],
    outcome: 'failure',
  };
}

// ---------------------------------------------------------------------------
// Conditions and exhaustion
// ---------------------------------------------------------------------------

/**
 * Add a condition (no duplicates; refreshes source/duration). Use changeExhaustion for exhaustion —
 * adding "Exhaustion" here is forwarded to it (gaining `level` levels, default 1). Standard names and
 * simple aliases ("knocked prone") map to standard ids; anything else is kept as a homebrew condition.
 * Incapacitating conditions end Concentration.
 */
export function addCondition(c: Character, condition: ActiveCondition): EngineResult {
  const raw = String(condition.id ?? '').trim();
  if (!raw) return unchanged(c, 'A condition needs a name.');
  const standard = matchStandardCondition(raw);
  if (standard?.id === 'exhaustion') return changeExhaustion(c, Math.max(1, toInt(condition.level, 1)));
  if (c.deathSaves.dead) return unchanged(c, "The dead don't gain conditions.");
  if (standard?.id === 'poisoned' && hasCondition(c, 'petrified')) return unchanged(c, 'Petrified creatures have Immunity to the Poisoned condition.');

  const id = standard?.id ?? raw;
  const entry: ActiveCondition = { ...condition, id };
  if (standard?.detail && !entry.source) entry.source = standard.detail;
  const key = conditionKey(id);
  const index = c.conditions.findIndex((x) => conditionKey(x.id) === key);
  const conditions = index >= 0 ? c.conditions.map((x, i) => (i === index ? entry : x)) : [...c.conditions, entry];

  const details = [entry.duration, entry.source].filter((d): d is string => !!d?.trim()).join(', ');
  const name = conditionName(id);
  const info = standard ? CONDITIONS[standard.id].summary : '';
  const message = `${index >= 0 ? 'Refreshed' : 'Now'} ${name}${details ? ` (${details})` : ''}${info ? ` — ${info}` : ''}`;
  let next: EngineResult = { character: { ...c, conditions }, events: [gameEvent('condition-added', message)] };
  if (INCAPACITATING_CONDITIONS.has(key)) {
    const ended = endConcentration(next.character, name);
    next = { character: ended.character, events: [...next.events, ...ended.events] };
  }
  return { character: touch(next.character), events: next.events };
}

/**
 * Remove a condition by id or name. Removing "Exhaustion" clears every level (use changeExhaustion to
 * lower it by one). When Unconscious ends the character remains Prone (SRD 5.2.1).
 */
export function removeCondition(c: Character, conditionId: string): EngineResult {
  const raw = String(conditionId ?? '').trim();
  if (!raw) return unchanged(c, 'Which condition should be removed?');
  const exactKey = conditionKey(raw);
  const standard = c.conditions.some((x) => conditionKey(x.id) === exactKey) ? null : matchStandardCondition(raw);
  if (standard?.id === 'exhaustion') {
    return exhaustionLevel(c) > 0 ? changeExhaustion(c, -exhaustionLevel(c)) : unchanged(c, 'No Exhaustion to remove.');
  }
  const key = standard ? standard.id : exactKey;
  if (!c.conditions.some((x) => conditionKey(x.id) === key)) return unchanged(c, `Not ${conditionName(key)} — nothing to remove.`);

  let conditions = withoutCondition(c.conditions, key);
  let message = `No longer ${conditionName(key)}.`;
  if (key === 'unconscious' && !c.conditions.some((x) => conditionKey(x.id) === 'prone')) {
    conditions = withCondition(conditions, { id: 'prone', source: 'Was unconscious' });
    message += ' Still Prone (standing up costs half your Speed).';
  }
  return { character: touch({ ...c, conditions }), events: [gameEvent('condition-removed', message)] };
}

/** Change exhaustion by delta, clamped 0–6. Reaching 6 = death (2024). */
export function changeExhaustion(c: Character, delta: number): EngineResult {
  const d = toInt(delta);
  if (d === 0) return { character: c, events: [] };
  if (c.deathSaves.dead) return unchanged(c, 'Already dead.');
  const before = exhaustionLevel(c);
  const after = clamp(before + d, 0, 6);
  if (after === before) return unchanged(c, before === 0 ? 'No Exhaustion to remove.' : `Exhaustion is already ${before}.`);
  if (after === 6) {
    return die(
      { ...c, exhaustion: 6, hp: { ...c.hp, temp: 0 } },
      { ...c.deathSaves, stable: false, dead: true },
      `Exhaustion ${before} → 6 — dies of exhaustion.`,
    );
  }
  const effect = after > 0 ? ` (${MINUS}${2 * after} to D20 Tests, ${MINUS}${5 * after} ft Speed)` : ' — no longer exhausted';
  return {
    character: touch({ ...c, exhaustion: after }),
    events: [gameEvent('exhaustion-changed', `Exhaustion ${before} → ${after}${effect}`)],
  };
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

function rechargeText(uses: FeatureUses): string {
  switch (uses.recharge) {
    case 'short':
      return 'recharges on a Short or Long Rest';
    case 'long':
      return 'recharges on a Long Rest';
    case 'dawn':
      return 'recharges at dawn';
    case 'turn':
      return 'recharges each turn';
    default:
      return "doesn't recharge";
  }
}

const featureName = (f: Feature) => f.name;

/** Find a feature by (fuzzy, case-insensitive) name. */
export function findFeature(c: Character, name: string): Feature | undefined {
  return matchByName(c.features, name, featureName).match;
}

function replaceFeature(c: Character, feature: Feature): Character {
  return touch({ ...c, features: c.features.map((f) => (f.id === feature.id ? feature : f)) });
}

/** Use `amount` (default 1) uses of a limited-use feature. Warns if not enough uses remain. */
export function useFeature(c: Character, name: string, amount = 1): EngineResult {
  const found = matchByName(c.features, name, featureName);
  const feature = found.match;
  if (!feature) return unchanged(c, lookupProblem('feature', name, found, featureName));
  if (!feature.uses) return unchanged(c, `${feature.name} has no limited uses to spend.`);
  const n = Math.max(1, toInt(amount, 1));
  const left = feature.uses.max - feature.uses.used;
  if (n > left) return unchanged(c, `Not enough uses of ${feature.name}: ${left} of ${feature.uses.max} left, ${n} needed.`);
  const uses = { ...feature.uses, used: feature.uses.used + n };
  return {
    character: replaceFeature(c, { ...feature, uses }),
    events: [gameEvent('feature-used', `Used ${feature.name}${n > 1 ? ` ×${n}` : ''} (${uses.max - uses.used}/${uses.max} left; ${rechargeText(uses)})`)],
  };
}

/** Restore all uses of a feature (or `amount` uses). */
export function restoreFeature(c: Character, name: string, amount?: number): EngineResult {
  const found = matchByName(c.features, name, featureName);
  const feature = found.match;
  if (!feature) return unchanged(c, lookupProblem('feature', name, found, featureName));
  if (!feature.uses) return unchanged(c, `${feature.name} has no limited uses to restore.`);
  if (feature.uses.used === 0) return unchanged(c, `${feature.name} is already fully available (${feature.uses.max}/${feature.uses.max}).`);
  const used = amount === undefined ? 0 : Math.max(0, feature.uses.used - Math.max(1, toInt(amount, 1)));
  const uses = { ...feature.uses, used };
  const regained = feature.uses.used - used;
  return {
    character: replaceFeature(c, { ...feature, uses }),
    events: [gameEvent('feature-restored', `${feature.name}: regained ${regained} use${regained === 1 ? '' : 's'} (${uses.max - used}/${uses.max})`)],
  };
}

/** Add a feature, or update the existing feature with the same name (keeping its id). */
export function addFeature(c: Character, feature: Omit<Feature, 'id'> & { id?: string }): EngineResult {
  const name = feature.name?.trim();
  if (!name) return unchanged(c, 'A feature needs a name.');
  const index = c.features.findIndex((f) => nameKey(f.name) === nameKey(name));
  if (index >= 0) {
    const updated: Feature = { ...c.features[index], ...feature, id: c.features[index].id, name };
    return { character: replaceFeature(c, updated), events: [gameEvent('feature-restored', `Updated feature: ${name}`)] };
  }
  const added: Feature = { ...feature, id: feature.id ?? newId(), name };
  const usesText = added.uses ? ` (${added.uses.max} use${added.uses.max === 1 ? '' : 's'}, ${rechargeText(added.uses)})` : '';
  return {
    character: touch({ ...c, features: [...c.features, added] }),
    events: [gameEvent('feature-restored', `Gained feature: ${name}${usesText}`)],
  };
}

export function removeFeature(c: Character, name: string): EngineResult {
  const found = matchByName(c.features, name, featureName);
  const feature = found.match;
  if (!feature) return unchanged(c, lookupProblem('feature', name, found, featureName));
  return {
    character: touch({ ...c, features: c.features.filter((f) => f.id !== feature.id) }),
    events: [gameEvent('feature-used', `Removed feature: ${feature.name}`)],
  };
}

/** Gain or spend Heroic Inspiration. You can never have more than one (SRD 5.2.1). */
export function setHeroicInspiration(c: Character, value: boolean): EngineResult {
  if (value === c.heroicInspiration) {
    return unchanged(
      c,
      value
        ? 'Already has Heroic Inspiration — you can only have one (give the new one to an ally who lacks it, or it is lost).'
        : 'No Heroic Inspiration to spend.',
    );
  }
  return {
    character: touch({ ...c, heroicInspiration: value }),
    events: [
      value
        ? gameEvent('feature-restored', 'Gained Heroic Inspiration (spend it to reroll any one die).')
        : gameEvent('feature-used', 'Spent Heroic Inspiration.'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

const itemName = (i: InventoryItem) => i.name;
const MAX_ATTUNED = 3;

/** Find an inventory item by (fuzzy, case-insensitive) name. */
export function findItem(c: Character, name: string): InventoryItem | undefined {
  return matchByName(c.inventory, name, itemName).match;
}

/** Add an item; stacks onto an existing item with the same name (non-magic, no charges). */
export function addItem(c: Character, item: Omit<InventoryItem, 'id'> & { id?: string }): EngineResult {
  const name = item.name?.trim();
  if (!name) return unchanged(c, 'An item needs a name.');
  const quantity = Math.max(1, toInt(item.quantity, 1));
  const stackable = !item.magic && !item.charges;
  const index = stackable
    ? c.inventory.findIndex((i) => nameKey(i.name) === nameKey(name) && !i.magic && !i.charges)
    : -1;
  if (index >= 0) {
    const existing = c.inventory[index];
    const total = existing.quantity + quantity;
    return {
      character: touch({ ...c, inventory: c.inventory.map((i, n) => (n === index ? { ...i, quantity: total } : i)) }),
      events: [gameEvent('item-added', `Added ${quantity} × ${existing.name} (now ${total})`)],
    };
  }
  const added: InventoryItem = { ...item, id: item.id ?? newId(), name, quantity };
  return {
    character: touch({ ...c, inventory: [...c.inventory, added] }),
    events: [gameEvent('item-added', `Added ${quantity > 1 ? `${quantity} × ` : ''}${name}`)],
  };
}

/** Remove `quantity` (default all) of an item. Warns if the item is missing or the quantity is too high. */
export function removeItem(c: Character, name: string, quantity?: number): EngineResult {
  const found = matchByName(c.inventory, name, itemName);
  const item = found.match;
  if (!item) return unchanged(c, lookupProblem('item', name, found, itemName));
  const n = quantity === undefined ? item.quantity : Math.max(1, toInt(quantity, 1));
  if (n > item.quantity) return unchanged(c, `Only ${item.quantity} × ${item.name} — can't remove ${n}.`);
  const left = item.quantity - n;
  const inventory = left > 0 ? c.inventory.map((i) => (i.id === item.id ? { ...i, quantity: left } : i)) : c.inventory.filter((i) => i.id !== item.id);
  return {
    character: touch({ ...c, inventory }),
    events: [gameEvent('item-removed', `Removed ${n} × ${item.name}${left > 0 ? ` (${left} left)` : ''}`)],
  };
}

function describePatch(patch: Partial<Omit<InventoryItem, 'id'>>): string {
  const parts: string[] = [];
  if (patch.name !== undefined) parts.push(`renamed to ${patch.name}`);
  if (patch.quantity !== undefined) parts.push(`quantity ${patch.quantity}`);
  if (patch.equipped !== undefined) parts.push(patch.equipped ? 'equipped' : 'unequipped');
  if (patch.attuned !== undefined) parts.push(patch.attuned ? 'attuned' : 'no longer attuned');
  if (patch.charges !== undefined) parts.push(`charges ${patch.charges.max - patch.charges.used}/${patch.charges.max}`);
  const other = Object.keys(patch).filter((k) => !['name', 'quantity', 'equipped', 'attuned', 'charges'].includes(k));
  if (other.length) parts.push(`${other.join(', ')} changed`);
  return parts.join(', ');
}

/**
 * Patch an item. Setting quantity below 1 removes it. Attuning a 4th item is refused (a creature can
 * be attuned to at most three magic items).
 */
export function updateItem(c: Character, name: string, patch: Partial<Omit<InventoryItem, 'id'>>): EngineResult {
  const found = matchByName(c.inventory, name, itemName);
  const item = found.match;
  if (!item) return unchanged(c, lookupProblem('item', name, found, itemName));
  if (patch.name !== undefined && !patch.name.trim()) return unchanged(c, "An item's name can't be empty.");
  if (patch.attuned && !item.attuned) {
    const attuned = c.inventory.filter((i) => i.attuned).length;
    if (attuned >= MAX_ATTUNED) return unchanged(c, `Already attuned to ${MAX_ATTUNED} magic items — end an Attunement first.`);
  }
  const updated: InventoryItem = { ...item, ...patch, id: item.id, ...(patch.name ? { name: patch.name.trim() } : {}) };
  if (updated.quantity < 1) {
    return {
      character: touch({ ...c, inventory: c.inventory.filter((i) => i.id !== item.id) }),
      events: [gameEvent('item-removed', `Removed ${item.name} (quantity 0)`)],
    };
  }
  const change = describePatch(patch);
  return {
    character: touch({ ...c, inventory: c.inventory.map((i) => (i.id === item.id ? updated : i)) }),
    events: [gameEvent('item-added', `Updated ${item.name}${change ? `: ${change}` : ''}`)],
  };
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

type Coin = keyof Currency;
/** Lowest to highest value. */
const COINS: readonly Coin[] = ['cp', 'sp', 'ep', 'gp', 'pp'];
const CP_VALUE: Record<Coin, number> = { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 };
/** Breaking one coin gives coins of the next denomination down (electrum breaks into silver). */
const BREAKS_INTO: Partial<Record<Coin, Coin>> = { pp: 'gp', gp: 'sp', ep: 'sp', sp: 'cp' };

function valueInCp(purse: Currency): number {
  return COINS.reduce((sum, coin) => sum + Math.max(0, toInt(purse[coin])) * CP_VALUE[coin], 0);
}

/** Total wealth expressed in gp (fractional). */
export function totalGp(currency: Currency): number {
  return valueInCp(currency) / 100;
}

/** "23 gp, 30 sp, 14 cp" (highest first, zeros omitted). */
export function formatCurrency(currency: Partial<Currency>): string {
  const parts = [...COINS].reverse().flatMap((coin) => {
    const n = toInt(currency[coin]);
    return n ? [`${formatInt(n)} ${coin}`] : [];
  });
  return parts.length ? parts.join(', ') : 'no coins';
}

/** Break the smallest available coin worth more than `target`, cascading down so change comes in natural coins. */
function breakLargerCoin(have: Currency, target: Coin): boolean {
  const source = COINS.find((coin) => CP_VALUE[coin] > CP_VALUE[target] && have[coin] > 0);
  if (!source) return false;
  have[source] -= 1;
  let coin: Coin = source;
  while (coin !== target) {
    const next: Coin = coin === 'gp' && target === 'ep' ? 'ep' : (BREAKS_INTO[coin] as Coin);
    const count = CP_VALUE[coin] / CP_VALUE[next];
    if (next === target) {
      have[next] += count;
      break;
    }
    have[next] += count - 1; // keep the rest as change, break one more
    coin = next;
  }
  return true;
}

/** Pay debts largest coin first; break larger coins when short, else pay with smaller coins. Caller checks affordability. */
function payFrom(purse: Currency, owed: Currency): Currency {
  const have = { ...purse };
  const debt = { ...owed };
  for (const coin of [...COINS].reverse()) {
    while (debt[coin] > 0) {
      if (have[coin] > 0) {
        const pay = Math.min(have[coin], debt[coin]);
        have[coin] -= pay;
        debt[coin] -= pay;
      } else if (!breakLargerCoin(have, coin)) {
        const smaller = BREAKS_INTO[coin];
        if (!smaller) throw new Error('payFrom: unaffordable debt (affordability must be checked first)');
        debt[smaller] += debt[coin] * (CP_VALUE[coin] / CP_VALUE[smaller]);
        debt[coin] = 0;
      }
    }
  }
  return have;
}

/**
 * Add (positive) or spend (negative) coins. When spending, make change automatically from larger
 * denominations (1 pp = 10 gp, 1 gp = 10 sp = 2 ep, 1 sp = 10 cp); with no larger coins left, smaller
 * coins pay instead. Gains in the same delta arrive before paying. Warns and changes nothing if the
 * character cannot afford it.
 */
export function changeCurrency(c: Character, delta: Partial<Currency>): EngineResult {
  const gains: Currency = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  const costs: Currency = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  for (const coin of COINS) {
    const n = toInt(delta[coin]);
    if (n > 0) gains[coin] = n;
    else if (n < 0) costs[coin] = -n;
  }
  const gaining = valueInCp(gains) > 0;
  const spending = valueInCp(costs) > 0;
  if (!gaining && !spending) return { character: c, events: [] };

  const purse: Currency = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  for (const coin of COINS) purse[coin] = Math.max(0, toInt(c.currency[coin])) + gains[coin];
  if (valueInCp(purse) < valueInCp(costs)) {
    return unchanged(
      c,
      `Can't afford ${formatCurrency(costs)} — only ${formatCurrency(c.currency)} (${formatGp(totalGp(c.currency))} gp in all). Nothing was spent.`,
    );
  }
  const after = spending ? payFrom(purse, costs) : purse;
  const what = [gaining ? `gained ${formatCurrency(gains)}` : '', spending ? `spent ${formatCurrency(costs)}` : ''].filter(Boolean).join(', ');
  return {
    character: touch({ ...c, currency: after }),
    events: [gameEvent('currency-changed', `${what.charAt(0).toUpperCase()}${what.slice(1)} — purse: ${formatCurrency(after)}`)],
  };
}

function formatGp(gp: number): string {
  return Number.isInteger(gp) ? String(gp) : gp.toFixed(2);
}

// ---------------------------------------------------------------------------
// Experience
// ---------------------------------------------------------------------------

/** Add XP; reports whether the new total reaches the next level (for XP-based campaigns). */
export function gainXp(c: Character, amount: number): EngineResult & { levelUpAvailable: boolean } {
  const n = toInt(amount);
  const level = characterLevel(c);
  if (n === 0) return { character: c, events: [], levelUpAvailable: levelForXp(c.xp) > level };
  const xp = Math.max(0, toInt(c.xp) + n);
  const reachable = levelForXp(xp);
  const levelUpAvailable = reachable > level && level < 20;
  const next = touch({ ...c, xp });
  const change = n > 0 ? `+${formatInt(n)}` : `${MINUS}${formatInt(-n)}`;
  const tail = levelUpAvailable ? ` — enough for level ${reachable}: level up available!` : '';
  return {
    character: next,
    events: [gameEvent('xp-gained', `${change} XP (${formatInt(xp)} total)${tail}`)],
    levelUpAvailable,
  };
}

// ---------------------------------------------------------------------------
// Spells and concentration
// ---------------------------------------------------------------------------

/** The most likely casting ability for a character without a Spellcasting block: class, else best of INT/WIS/CHA. */
function guessSpellAbility(c: Character): Ability {
  const fromClass = spellcastingAbility(c);
  if (fromClass) return fromClass;
  const mental: Ability[] = ['int', 'wis', 'cha'];
  return mental.reduce((best, a) => (abilityModifier(c.abilityScores[a]) > abilityModifier(c.abilityScores[best]) ? a : best));
}

function ensureSpellcasting(c: Character): Spellcasting {
  return c.spellcasting ?? { ability: guessSpellAbility(c), slots: {}, spells: [], concentratingOn: null };
}

const knownSpellName = (s: KnownSpell) => s.name;

/** Add a spell, or update the known spell with the same name (keeping its id). */
export function addSpell(c: Character, spell: Omit<KnownSpell, 'id'> & { id?: string }): EngineResult {
  const name = spell.name?.trim();
  if (!name) return unchanged(c, 'A spell needs a name.');
  const sc = ensureSpellcasting(c);
  const level = clamp(toInt(spell.level), 0, 9);
  const index = sc.spells.findIndex((s) => nameKey(s.name) === nameKey(name));
  const levelText = level === 0 ? 'cantrip' : `level ${level}`;
  if (index >= 0) {
    const updated: KnownSpell = { ...sc.spells[index], ...spell, id: sc.spells[index].id, name, level };
    const spells = sc.spells.map((s, i) => (i === index ? updated : s));
    return { character: touch({ ...c, spellcasting: { ...sc, spells } }), events: [gameEvent('feature-restored', `Updated spell: ${name} (${levelText})`)] };
  }
  const added: KnownSpell = { ...spell, id: spell.id ?? newId(), name, level };
  return {
    character: touch({ ...c, spellcasting: { ...sc, spells: [...sc.spells, added] } }),
    events: [gameEvent('feature-restored', `Added spell: ${name} (${levelText}${added.prepared ? ', prepared' : ''})`)],
  };
}

export function removeSpell(c: Character, name: string): EngineResult {
  const sc = c.spellcasting;
  if (!sc) return unchanged(c, `No spell named "${name}".`);
  const found = matchByName(sc.spells, name, knownSpellName);
  const spell = found.match;
  if (!spell) return unchanged(c, lookupProblem('spell', name, found, knownSpellName));
  const concentrating = sc.concentratingOn && nameKey(sc.concentratingOn) === nameKey(spell.name);
  const spellcasting: Spellcasting = {
    ...sc,
    spells: sc.spells.filter((s) => s.id !== spell.id),
    ...(concentrating ? { concentratingOn: null } : {}),
  };
  const events = [gameEvent('feature-used', `Removed spell: ${spell.name}`)];
  if (concentrating) events.push(gameEvent('condition-removed', `Concentration on ${spell.name} ends.`));
  return { character: touch({ ...c, spellcasting }), events };
}

/** Start (name) or end (null) concentration. Starting a new one ends the previous. */
export function setConcentration(c: Character, spellName: string | null): EngineResult {
  const current = c.spellcasting?.concentratingOn ?? null;
  const name = spellName?.trim() || null;
  if (name === null) {
    if (!current || !c.spellcasting) return { character: c, events: [] };
    return {
      character: touch({ ...c, spellcasting: { ...c.spellcasting, concentratingOn: null } }),
      events: [gameEvent('condition-removed', `No longer concentrating on ${current}.`)],
    };
  }
  if (current && nameKey(current) === nameKey(name)) return { character: c, events: [] };
  if (c.deathSaves.dead) return unchanged(c, "The dead can't concentrate.");
  const incapacitated = c.conditions.map((x) => conditionKey(x.id)).find((k) => INCAPACITATING_CONDITIONS.has(k));
  if (incapacitated) return unchanged(c, `Can't concentrate while ${conditionName(incapacitated)}.`);
  const known = c.spellcasting ? matchByName(c.spellcasting.spells, name, knownSpellName).match : undefined;
  const label = known?.name ?? name;
  const sc = ensureSpellcasting(c);
  const events: GameEvent[] = [];
  if (current) events.push(gameEvent('condition-removed', `Concentration on ${current} ends (started concentrating on ${label}).`));
  events.push(gameEvent('condition-added', `Concentrating on ${label}.`));
  return { character: touch({ ...c, spellcasting: { ...sc, concentratingOn: label } }), events };
}
