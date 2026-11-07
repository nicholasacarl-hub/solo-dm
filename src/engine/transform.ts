/**
 * Transformations: lasting, story-driven changes to the hero — vampirism, lycanthropy, a fey mark,
 * a celestial blessing. These pure functions apply a transformation's
 * whole change at once — features, damage defenses, condition immunities, Darkvision and other
 * speeds, walking speed, size and ability scores — and record it on the character as a
 * Transformation together with exactly what it changed, so a later stage adds to it and its end (a
 * cure, a reversal) undoes precisely what it granted and never the hero's own traits.
 *
 * Rules (SRD 5.2.1): ability scores range from 1 to 30 and a changed Constitution modifier changes
 * the Hit Point maximum as though it applied from level 1 (changeAbilityScore); Resistance and
 * Vulnerability to one damage type don't stack (Rules Glossary), so a defense the hero already has
 * isn't added twice and isn't taken away when the transformation ends; a Darkvision grant sets a
 * longer range rather than adding to it (as the Drow lineage's "increases to 120 feet" does).
 */
import type {
  Ability,
  Character,
  CreatureSize,
  Feature,
  FeatureUses,
  GameEvent,
  GrantedEntries,
  GrantedNumber,
  OtherSpeed,
  Transformation,
  TransformationDefenseKind,
  TransformationGrants,
} from '@/types';
import { nameKey, newId as randomId } from '@/lib/id';
import { ABILITY_SCORE_LIMIT, changeAbilityScore, removeCondition, type EngineResult } from './character';
import { conditionKey, conditionName, matchStandardCondition } from './conditions';
import { syncArmorClass } from './rules';
import { gameEvent, lookupProblem, matchByName, toInt, touch, warning } from './util';

// ---------------------------------------------------------------------------
// Inputs and the record of what a transformation changed
// ---------------------------------------------------------------------------

export type { GrantedEntries, GrantedNumber, OtherSpeed, TransformationGrants };
export const OTHER_SPEEDS: readonly OtherSpeed[] = ['fly', 'swim', 'climb', 'burrow'];

export type DefenseKind = TransformationDefenseKind;
const DEFENSE_KINDS: readonly DefenseKind[] = ['resistances', 'immunities', 'vulnerabilities', 'conditionImmunities'];

type DefenseField = 'damageResistances' | 'damageImmunities' | 'damageVulnerabilities' | 'conditionImmunities';
const DEFENSE_FIELD: Record<DefenseKind, DefenseField> = {
  resistances: 'damageResistances',
  immunities: 'damageImmunities',
  vulnerabilities: 'damageVulnerabilities',
  conditionImmunities: 'conditionImmunities',
};

export interface TransformationFeatureSpec {
  name: string;
  description: string;
  uses?: Pick<FeatureUses, 'max' | 'recharge'>;
}

/** The mechanical side of a transformation (or of one of its stages). */
export interface TransformationChanges {
  /** Powers and drawbacks, added as features with source 'transformation'. */
  features?: readonly TransformationFeatureSpec[];
  /** Damage types for resistances / immunities / vulnerabilities; condition names for condition immunities. */
  defenses?: Partial<Record<DefenseKind, readonly string[]>>;
  /** Darkvision range in feet (a longer range the hero already has is kept). */
  darkvision?: number;
  /** Fly / swim / climb / burrow speeds in feet (a faster one the hero already has is kept). */
  otherSpeeds?: Partial<Record<OtherSpeed, number>>;
  /** Change to walking speed in feet (+10, −10). */
  speedChange?: number;
  size?: CreatureSize;
  /** Ability score changes (scores stay within 1–30). */
  abilityChanges?: readonly { ability: Ability; change: number }[];
}

export interface BeginTransformationSpec extends TransformationChanges {
  name: string;
  summary: string;
  origin: Transformation['origin'];
  stage?: string;
  howItEnds?: string;
}

export interface AdvanceTransformationSpec extends TransformationChanges {
  /** The new stage, e.g. "Stage 2: the hunger". */
  stage: string;
  summary?: string;
  howItEnds?: string;
  /** Names of this transformation's own features that the new stage takes away or replaces. */
  removeFeatures?: readonly string[];
}

export interface TransformationOptions {
  /** Session number recorded as startedSession / endedSession. */
  session: number;
  now?: number;
  newId?: () => string;
}

export interface TransformationResult extends EngineResult {
  /** The transformation as recorded, or undefined when nothing changed (a warning event says why). */
  transformation?: Transformation;
}

/** A Transformation as the engine records it (the type now carries grants itself). */
export type TransformationRecord = Transformation;

/** What a transformation changed on the sheet (empty for records without it). */
export function transformationGrants(t: Transformation): TransformationGrants {
  return t.grants ?? {};
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function activeTransformations(c: Character): Transformation[] {
  return (c.transformations ?? []).filter((t) => t.status === 'active');
}

/** An active transformation by (fuzzy, case-insensitive) name. */
export function findTransformation(c: Character, name: string): Transformation | undefined {
  return matchByName(activeTransformations(c), name, (t) => t.name).match;
}

/** The hero's features that belong to a transformation. */
export function transformationFeatures(c: Character, t: Transformation): Feature[] {
  const ids = new Set(t.featureIds);
  return c.features.filter((f) => ids.has(f.id));
}

// ---------------------------------------------------------------------------
// Applying changes (each step returns a new working copy)
// ---------------------------------------------------------------------------

interface Working {
  character: Character;
  record: TransformationRecord;
  /** The hero's other transformations (records may change when an ending hands a defense over). */
  others: TransformationRecord[];
  events: GameEvent[];
}

const key = (text: string) => text.trim().toLowerCase();
const MINUS = '−';

function signed(n: number): string {
  return n < 0 ? `${MINUS}${Math.abs(n)}` : `+${n}`;
}

function usesText(uses: FeatureUses): string {
  const per: Record<FeatureUses['recharge'], string> = {
    short: 'per Short or Long Rest',
    long: 'per Long Rest',
    dawn: 'per dawn',
    turn: 'per turn',
    none: 'in total',
  };
  return `${uses.max} ${uses.max === 1 ? 'use' : 'uses'} ${per[uses.recharge]}`;
}

function withGrants(w: Working, patch: Partial<TransformationGrants>): Working {
  return { ...w, record: { ...w.record, grants: { ...transformationGrants(w.record), ...patch } } };
}

function note(w: Working, event: GameEvent): Working {
  return { ...w, events: [...w.events, event] };
}

// -- features ---------------------------------------------------------------

/** A name for a new transformation feature that doesn't collide with one the hero already has. */
function freeFeatureName(c: Character, name: string, transformationName: string): string {
  const taken = (n: string) => c.features.some((f) => nameKey(f.name) === nameKey(n));
  if (!taken(name)) return name;
  const qualified = `${name} (${transformationName})`;
  if (!taken(qualified)) return qualified;
  let n = 2;
  while (taken(`${qualified} ${n}`)) n += 1;
  return `${qualified} ${n}`;
}

function addFeatures(w: Working, specs: readonly TransformationFeatureSpec[], makeId: () => string): Working {
  let next = w;
  for (const spec of specs) {
    const name = spec.name.trim();
    if (!name) continue;
    const uses = spec.uses ? { max: Math.max(1, toInt(spec.uses.max, 1)), recharge: spec.uses.recharge } : undefined;
    const own = transformationFeatures(next.character, next.record).find((f) => nameKey(f.name) === nameKey(name));
    if (own) {
      // A later stage strengthens or rewrites one of its own features: update it in place.
      const updated: Feature = {
        ...own,
        description: spec.description,
        ...(uses ? { uses: { ...uses, used: Math.min(own.uses?.used ?? 0, uses.max) } } : {}),
      };
      next = {
        ...next,
        character: { ...next.character, features: next.character.features.map((f) => (f.id === own.id ? updated : f)) },
        events: [...next.events, gameEvent('feature-added', `Feature changed: ${own.name}${uses ? ` (${usesText({ ...uses, used: 0 })})` : ''}`)],
      };
      continue;
    }
    const feature: Feature = {
      id: makeId(),
      name: freeFeatureName(next.character, name, next.record.name),
      source: 'transformation',
      sourceName: next.record.name,
      description: spec.description,
      ...(uses ? { uses: { ...uses, used: 0 } } : {}),
    };
    next = {
      ...next,
      character: { ...next.character, features: [...next.character.features, feature] },
      record: { ...next.record, featureIds: [...next.record.featureIds, feature.id] },
      events: [...next.events, gameEvent('feature-added', `Gained feature: ${feature.name}${feature.uses ? ` (${usesText(feature.uses)})` : ''}`)],
    };
  }
  return next;
}

function removeOwnFeatures(w: Working, names: readonly string[]): Working {
  let next = w;
  for (const name of names) {
    const own = transformationFeatures(next.character, next.record);
    const found = matchByName(own, name, (f) => f.name);
    if (!found.match) {
      next = note(next, warning(`${lookupProblem('feature', name, found, (f) => f.name)} ${next.record.name} has: ${own.map((f) => f.name).join(', ') || 'no features'}.`));
      continue;
    }
    const id = found.match.id;
    next = {
      ...next,
      character: { ...next.character, features: next.character.features.filter((f) => f.id !== id) },
      record: { ...next.record, featureIds: next.record.featureIds.filter((x) => x !== id) },
      events: [...next.events, gameEvent('feature-removed', `Lost feature: ${found.match.name}`)],
    };
  }
  return next;
}

// -- damage defenses and condition immunities ---------------------------------

/** "necrotic" → "Necrotic"; condition names become the standard name ("poisoned" → "Poisoned"). */
function cleanEntry(kind: DefenseKind, raw: string): string {
  const text = raw.trim().replace(/\s+/g, ' ');
  if (kind === 'conditionImmunities') {
    const standard = matchStandardCondition(text);
    if (standard && !standard.detail) return conditionName(standard.id);
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function defenseText(kind: DefenseKind, entry: string): string {
  switch (kind) {
    case 'resistances':
      return `Resistance to ${entry} damage`;
    case 'immunities':
      return `Immunity to ${entry} damage`;
    case 'vulnerabilities':
      return `Vulnerability to ${entry} damage`;
    default:
      return `Immunity to the ${entry} condition`;
  }
}

function addDefenses(w: Working, defenses: Partial<Record<DefenseKind, readonly string[]>>): Working {
  let next = w;
  for (const kind of DEFENSE_KINDS) {
    const entries = (defenses[kind] ?? []).map((e) => cleanEntry(kind, e)).filter(Boolean);
    if (entries.length === 0) continue;
    const field = DEFENSE_FIELD[kind];
    const sheet = [...(next.character[field] ?? [])];
    const prev = transformationGrants(next.record).defenses?.[kind] ?? { granted: [], added: [] };
    const granted = [...prev.granted];
    const added = [...prev.added];
    const events: GameEvent[] = [];
    for (const entry of entries) {
      if (!granted.some((g) => key(g) === key(entry))) granted.push(entry);
      if (sheet.some((s) => key(s) === key(entry))) continue;
      sheet.push(entry);
      added.push(entry);
      events.push(gameEvent('transformation', defenseText(kind, entry)));
    }
    next = withGrants(
      { ...next, character: { ...next.character, [field]: sheet }, events: [...next.events, ...events] },
      { defenses: { ...transformationGrants(next.record).defenses, [kind]: { granted, added } } },
    );
    if (kind === 'conditionImmunities') next = endConditionsNowImmune(next, added);
  }
  return next;
}

/** A condition the hero is now immune to no longer affects them (SRD 5.2.1 Rules Glossary, "Immunity"). */
function endConditionsNowImmune(w: Working, immunities: readonly string[]): Working {
  let next = w;
  for (const immunity of immunities) {
    const active = next.character.conditions.find((x) => conditionKey(x.id) === conditionKey(immunity));
    if (!active) continue;
    const r = removeCondition(next.character, active.id);
    next = { ...next, character: r.character, events: [...next.events, ...r.events] };
  }
  return next;
}

/**
 * Take away the defenses this transformation added. One that another active transformation also
 * grants stays on the sheet, and that transformation takes it over (so its own end removes it).
 */
function removeDefenses(w: Working): Working {
  let next = w;
  for (const kind of DEFENSE_KINDS) {
    const mine = transformationGrants(next.record).defenses?.[kind];
    if (!mine?.added.length) continue;
    const field = DEFENSE_FIELD[kind];
    let sheet = [...(next.character[field] ?? [])];
    let others = next.others;
    const events: GameEvent[] = [];
    for (const entry of mine.added) {
      const heir = others.find((o) => o.status === 'active' && transformationGrants(o).defenses?.[kind]?.granted.some((g) => key(g) === key(entry)));
      if (heir) {
        const grants = transformationGrants(heir);
        const theirs = grants.defenses?.[kind] ?? { granted: [], added: [] };
        const updated: TransformationRecord = {
          ...heir,
          grants: { ...grants, defenses: { ...grants.defenses, [kind]: { ...theirs, added: [...theirs.added, entry] } } },
        };
        others = others.map((o) => (o.id === heir.id ? updated : o));
        continue;
      }
      if (!sheet.some((s) => key(s) === key(entry))) continue;
      sheet = sheet.filter((s) => key(s) !== key(entry));
      events.push(gameEvent('transformation', `Loses ${defenseText(kind, entry)}`));
    }
    next = { ...next, others, character: { ...next.character, [field]: sheet }, events: [...next.events, ...events] };
  }
  return next;
}

// -- Darkvision and other speeds (a longer range / faster speed wins; never added up) ------------

interface NumberTrait {
  label: string;
  get: (c: Character) => number;
  set: (c: Character, value: number) => Character;
  grant: (g: TransformationGrants) => GrantedNumber | undefined;
  withGrant: (g: TransformationGrants, value: GrantedNumber | undefined) => Partial<TransformationGrants>;
}

const DARKVISION: NumberTrait = {
  label: 'Darkvision',
  get: (c) => Math.max(0, toInt(c.darkvision)),
  set: (c, value) => ({ ...c, darkvision: value }),
  grant: (g) => g.darkvision,
  withGrant: (_g, value) => ({ darkvision: value }),
};

function otherSpeedTrait(kind: OtherSpeed): NumberTrait {
  return {
    label: `${kind.charAt(0).toUpperCase()}${kind.slice(1)} Speed`,
    get: (c) => Math.max(0, toInt(c.otherSpeeds?.[kind])),
    set: (c, value) => {
      const speeds = { ...c.otherSpeeds };
      if (value > 0) speeds[kind] = value;
      else delete speeds[kind];
      return { ...c, otherSpeeds: speeds };
    },
    grant: (g) => g.otherSpeeds?.[kind],
    withGrant: (g, value) => {
      const speeds = { ...g.otherSpeeds };
      if (value) speeds[kind] = value;
      else delete speeds[kind];
      return { otherSpeeds: speeds };
    },
  };
}

const feet = (n: number) => (n > 0 ? `${n} ft` : 'none');

const activeOthers = (w: Working) => w.others.filter((o) => o.status === 'active');

function grantNumber(w: Working, trait: NumberTrait, amount: number): Working {
  const value = Math.max(0, toInt(amount));
  if (value <= 0) return w;
  const current = trait.get(w.character);
  const mine = trait.grant(transformationGrants(w.record));
  // The hero's own value: as recorded by a transformation that already changes it, else what they have now.
  const recorded = activeOthers(w).map((o) => trait.grant(transformationGrants(o))).find((g) => g);
  const natural = mine?.natural ?? recorded?.natural ?? current;
  const granted: GrantedNumber = { value: Math.max(mine?.value ?? 0, value), natural };
  const next = withGrants(w, trait.withGrant(transformationGrants(w.record), granted));
  if (value <= current) return note(next, gameEvent('transformation', `${trait.label} stays ${feet(current)} (${w.record.name} gives ${feet(value)})`));
  return { ...next, character: trait.set(next.character, value), events: [...next.events, gameEvent('transformation', `${trait.label} ${feet(current)} → ${feet(value)}`)] };
}

function revertNumber(w: Working, trait: NumberTrait): Working {
  const mine = trait.grant(transformationGrants(w.record));
  if (!mine) return w;
  const others = activeOthers(w).flatMap((o) => trait.grant(transformationGrants(o))?.value ?? []);
  const current = trait.get(w.character);
  const expected = Math.max(mine.natural, mine.value, ...others);
  if (current !== expected) {
    return note(w, warning(`${trait.label} left at ${feet(current)}: it was changed by something else since ${w.record.name} began (the hero's own value was ${feet(mine.natural)}).`));
  }
  const restored = Math.max(mine.natural, ...others);
  if (restored === current) return w;
  return { ...w, character: trait.set(w.character, restored), events: [...w.events, gameEvent('transformation', `${trait.label} ${feet(current)} → ${feet(restored)}`)] };
}

// -- walking speed, size, ability scores ---------------------------------------

function changeSpeed(w: Working, change: number): Working {
  const delta = toInt(change);
  if (delta === 0) return w;
  const before = Math.max(0, toInt(w.character.speed));
  const after = Math.max(0, before + delta);
  const applied = after - before;
  if (applied === 0) return w;
  const total = (transformationGrants(w.record).speed ?? 0) + applied;
  const next = withGrants(w, { speed: total });
  return { ...next, character: { ...next.character, speed: after }, events: [...next.events, gameEvent('transformation', `Speed ${before} → ${after} ft (${signed(applied)} ft)`)] };
}

function revertSpeed(w: Working): Working {
  const applied = transformationGrants(w.record).speed ?? 0;
  if (applied === 0) return w;
  const before = Math.max(0, toInt(w.character.speed));
  const after = Math.max(0, before - applied);
  return { ...w, character: { ...w.character, speed: after }, events: [...w.events, gameEvent('transformation', `Speed ${before} → ${after} ft`)] };
}

type SizeGrant = NonNullable<TransformationGrants['size']>;

/** The size that wins among several transformations: the most recently set one, else the hero's own. */
function resolvedSize(natural: CreatureSize, grants: readonly SizeGrant[]): CreatureSize {
  if (grants.length === 0) return natural;
  return grants.reduce((latest, s) => (s.at >= latest.at ? s : latest)).size;
}

const otherSizes = (w: Working): SizeGrant[] => activeOthers(w).flatMap((o) => transformationGrants(o).size ?? []);

function setSize(w: Working, size: CreatureSize, at: number): Working {
  const mine = transformationGrants(w.record).size;
  const natural = mine?.natural ?? otherSizes(w)[0]?.natural ?? w.character.size;
  const next = withGrants(w, { size: { size, natural, at } });
  if (w.character.size === size) return next;
  return { ...next, character: { ...next.character, size }, events: [...next.events, gameEvent('transformation', `Size ${w.character.size} → ${size}`)] };
}

function revertSize(w: Working): Working {
  const mine = transformationGrants(w.record).size;
  if (!mine) return w;
  const expected = resolvedSize(mine.natural, [mine, ...otherSizes(w)]);
  if (w.character.size !== expected) {
    return note(w, warning(`Size left at ${w.character.size}: it was changed by something else since ${w.record.name} began (the hero's own size was ${mine.natural}).`));
  }
  const restored = resolvedSize(mine.natural, otherSizes(w));
  if (restored === w.character.size) return w;
  return { ...w, character: { ...w.character, size: restored }, events: [...w.events, gameEvent('transformation', `Size ${w.character.size} → ${restored}`)] };
}

function changeAbilities(w: Working, changes: readonly { ability: Ability; change: number }[]): Working {
  let next = w;
  for (const { ability, change } of changes) {
    const before = next.character.abilityScores[ability];
    const r = changeAbilityScore(next.character, ability, change, ABILITY_SCORE_LIMIT);
    const applied = r.character.abilityScores[ability] - before;
    const abilities = { ...transformationGrants(next.record).abilities };
    if (applied !== 0) abilities[ability] = (abilities[ability] ?? 0) + applied;
    next = withGrants({ ...next, character: r.character, events: [...next.events, ...r.events] }, { abilities });
  }
  return next;
}

function revertAbilities(w: Working): Working {
  const abilities = transformationGrants(w.record).abilities ?? {};
  let next = w;
  for (const [ability, applied] of Object.entries(abilities) as [Ability, number][]) {
    if (!applied) continue;
    const r = changeAbilityScore(next.character, ability, -applied, ABILITY_SCORE_LIMIT);
    next = { ...next, character: r.character, events: [...next.events, ...r.events] };
  }
  return next;
}

/** Apply a stage's mechanical changes. Armor Class follows ability score changes (syncArmorClass). */
function applyChanges(w: Working, changes: TransformationChanges, opts: { makeId: () => string; now: number }): Working {
  const start = w.character;
  let next = w;
  if (changes.features?.length) next = addFeatures(next, changes.features, opts.makeId);
  if (changes.defenses) next = addDefenses(next, changes.defenses);
  if (changes.darkvision !== undefined) next = grantNumber(next, DARKVISION, changes.darkvision);
  for (const kind of OTHER_SPEEDS) {
    const speed = changes.otherSpeeds?.[kind];
    if (speed !== undefined) next = grantNumber(next, otherSpeedTrait(kind), speed);
  }
  if (changes.speedChange !== undefined) next = changeSpeed(next, changes.speedChange);
  if (changes.size) next = setSize(next, changes.size, opts.now);
  if (changes.abilityChanges?.length) next = changeAbilities(next, changes.abilityChanges);
  return syncAc(next, start);
}

function syncAc(w: Working, start: Character): Working {
  const synced = syncArmorClass(start, w.character);
  return synced.events.length || synced.character !== w.character ? { ...w, character: synced.character, events: [...w.events, ...synced.events] } : w;
}

/** Put the working record (and any updated other records) back on the character. */
function commit(w: Working, now: number): TransformationResult {
  const record: TransformationRecord = { ...w.record, updatedAt: now };
  const others = new Map(w.others.map((o) => [o.id, o]));
  const existing = w.character.transformations ?? [];
  const list = existing.some((t) => t.id === record.id)
    ? existing.map((t) => (t.id === record.id ? record : (others.get(t.id) ?? t)))
    : [...existing.map((t) => others.get(t.id) ?? t), record];
  return { character: touch({ ...w.character, transformations: list }), events: w.events, transformation: record };
}

function working(c: Character, record: TransformationRecord): Working {
  const others = (c.transformations ?? []).filter((t) => t.id !== record.id) as TransformationRecord[];
  return { character: c, record, others, events: [] };
}

function unchanged(c: Character, message: string): TransformationResult {
  return { character: c, events: [warning(message)] };
}

function activeNames(c: Character): string {
  return activeTransformations(c).map((t) => t.name).join(', ') || 'none';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Begin a transformation: record it and apply its first stage's changes atomically. */
export function beginTransformation(c: Character, spec: BeginTransformationSpec, opts: TransformationOptions): TransformationResult {
  const name = spec.name.trim();
  if (!name) return unchanged(c, 'A transformation needs a name.');
  const summary = spec.summary.trim();
  if (!summary) return unchanged(c, `${name} needs a summary: what the hero is becoming, and what it costs.`);
  const duplicate = activeTransformations(c).find((t) => nameKey(t.name) === nameKey(name));
  if (duplicate) return unchanged(c, `${duplicate.name} is already active (${duplicate.stage ?? 'no stage'}). Advance it to a new stage instead.`);
  const now = opts.now ?? Date.now();
  const makeId = opts.newId ?? randomId;
  const record: TransformationRecord = {
    id: makeId(),
    name,
    summary,
    origin: spec.origin,
    status: 'active',
    featureIds: [],
    startedSession: opts.session,
    createdAt: now,
    updatedAt: now,
    ...(spec.stage?.trim() ? { stage: spec.stage.trim() } : {}),
    ...(spec.howItEnds?.trim() ? { howItEnds: spec.howItEnds.trim() } : {}),
  };
  const stage = record.stage ? ` (${record.stage})` : '';
  const begun = note(working(c, record), gameEvent('transformation', `Transformation begins: ${name}${stage} — ${spec.origin === 'accepted' ? 'chosen by the hero' : 'imposed by the story'}`));
  return commit(applyChanges(begun, spec, { makeId, now }), now);
}

/** Advance an active transformation to a new stage, adding (or replacing) traits. */
export function advanceTransformation(c: Character, name: string, spec: AdvanceTransformationSpec, opts: TransformationOptions): TransformationResult {
  const found = matchByName(activeTransformations(c), name, (t) => t.name);
  const current = found.match as TransformationRecord | undefined;
  if (!current) return unchanged(c, `${lookupProblem('active transformation', name, found, (t) => t.name)} Active: ${activeNames(c)}.`);
  const stage = spec.stage.trim();
  if (!stage) return unchanged(c, `Give ${current.name} its new stage.`);
  const now = opts.now ?? Date.now();
  const makeId = opts.newId ?? randomId;
  const record: TransformationRecord = {
    ...current,
    stage,
    ...(spec.summary?.trim() ? { summary: spec.summary.trim() } : {}),
    ...(spec.howItEnds?.trim() ? { howItEnds: spec.howItEnds.trim() } : {}),
  };
  let w = note(working(c, record), gameEvent('transformation', `${current.name}: ${current.stage ?? 'begun'} → ${stage}`));
  if (spec.removeFeatures?.length) w = removeOwnFeatures(w, spec.removeFeatures);
  return commit(applyChanges(w, spec, { makeId, now }), now);
}

/** End an active transformation (a cure, a reversal, a bargain fulfilled): undo everything it granted. */
export function endTransformation(c: Character, name: string, opts: TransformationOptions): TransformationResult {
  const found = matchByName(activeTransformations(c), name, (t) => t.name);
  const current = found.match as TransformationRecord | undefined;
  if (!current) return unchanged(c, `${lookupProblem('active transformation', name, found, (t) => t.name)} Active: ${activeNames(c)}.`);
  const now = opts.now ?? Date.now();
  const record: TransformationRecord = { ...current, status: 'ended', endedSession: opts.session };
  let w = note(working(c, record), gameEvent('transformation', `Transformation ends: ${current.name}`));
  const start = w.character;
  const lost = transformationFeatures(c, current);
  if (lost.length) {
    const ids = new Set(current.featureIds);
    w = {
      ...w,
      character: { ...w.character, features: w.character.features.filter((f) => !ids.has(f.id)) },
      events: [...w.events, ...lost.map((f) => gameEvent('feature-removed', `Lost feature: ${f.name}`))],
    };
  }
  w = removeDefenses(w);
  w = revertNumber(w, DARKVISION);
  for (const kind of OTHER_SPEEDS) w = revertNumber(w, otherSpeedTrait(kind));
  w = revertSpeed(w);
  w = revertSize(w);
  w = revertAbilities(w);
  return commit(syncAc(w, start), now);
}
