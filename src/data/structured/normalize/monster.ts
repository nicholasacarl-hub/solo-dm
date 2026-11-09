/**
 * The monster normalizer (spec §3.9): the wire's excerpts → MonsterData, parsed and grounded by app code,
 * cross-checked against SRD 5.2.1's monster rules ("Monsters": Experience Points by Challenge Rating,
 * Proficiency Bonus by CR, Hit Points as the average of the Hit Dice, Initiative = Dexterity modifier
 * (+ PB when proficient)), with the DM tool limits (AC 1–40, HP 1–2000, initiative −10…20, reach 5–60)
 * as `block` out-of-range. validateMonster re-checks edited or pack data.
 *
 * Owner: E2. Pure.
 */
import { CREATURE_SIZES, type AbilityScores, type CreatureSize, type CreatureSpeeds, type MonsterData, type RecordWarning } from '@/types';
import { adaptation } from '../adaptations';
import { parseCrLine, parseSpeeds, proficiencyBonusForCr, XP_BY_CR } from '../parse/srdRulesEntity';
import { CR_VALUES } from '../schemas';
import type { Wire } from '../wire';
import type { NormalizeContext, Normalized } from './index';
import { beginNormalize, finishNormalize, gradeConfidence, missing, numberInText, titleCase, ungrounded, warning } from './text';

/** Wire field → the data field its excerpt fills (warnings name data fields; excerpts keep wire names). */
export const MONSTER_FIELDS: Readonly<Record<string, string>> = {
  sizeText: 'size', typeText: 'type', alignmentText: 'alignment', acText: 'ac', hpText: 'hp', speedText: 'speeds',
  initiativeText: 'initiative', crText: 'cr', sensesText: 'senses', languagesText: 'languages', resistancesText: 'resistances',
  immunitiesText: 'immunities', vulnerabilitiesText: 'vulnerabilities', reachText: 'reachFt', abilityScores: 'abilities',
};
const KEY_FIELDS = ['sizeText', 'typeText', 'acText', 'hpText', 'speedText', 'crText', 'abilityScores'];
const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

const SPEED_ORDER = ['walk', 'burrow', 'climb', 'fly', 'swim'] as const;
/** The app's own speed line from the parsed speeds: "30 ft., fly 60 ft. (hover)". */
export function speedLine(speeds: CreatureSpeeds): string {
  return SPEED_ORDER.filter((k) => speeds[k] !== undefined)
    .map((k) => `${k === 'walk' ? '' : `${k} `}${speeds[k]} ft.${k === 'fly' && speeds.hover ? ' (hover)' : ''}`)
    .join(', ');
}

export const abilityModifier = (score: number): number => Math.floor((score - 10) / 2);

/** The average of a dice expression ("8d10 + 8" → 52), rounded down; null when it isn't one. */
export function averageOf(dice: string): number | null {
  const m = /^\s*(\d+)\s*d\s*(\d+)\s*(?:([+\-−–])\s*(\d+))?\s*$/i.exec(dice);
  if (!m) return null;
  const mod = m[4] ? Number(m[4]) * (m[3] === '+' ? 1 : -1) : 0;
  return Math.floor((Number(m[1]) * (Number(m[2]) + 1)) / 2 + mod);
}

const SIZE_WORD = /\b(tiny|small|medium|large|huge|gargantuan)\b/gi;
const sizeOf = (word: string) => CREATURE_SIZES.find((s) => s.toLowerCase() === word.toLowerCase()) as CreatureSize;

/** "Humanoid (Goblinoid)" → Humanoid + [Goblinoid]; "Swarm of Tiny Beasts" → Beast. */
function typeAndTags(text: string): { type: string; tags: string[] } {
  const t = text.replace(/\s+/g, ' ').trim();
  const swarm = /^Swarm of (?:\w+ )?(\w+?)s?$/i.exec(t);
  if (swarm) return { type: titleCase(swarm[1]), tags: [] };
  const m = /^(.+?)\s*\(([^)]*)\)\s*$/.exec(t);
  if (m) return { type: titleCase(m[1]), tags: m[2].split(/\s*,\s*/).map((x) => titleCase(x)).filter(Boolean) };
  return { type: titleCase(t), tags: [] };
}

/** The largest "reach N ft." on the full text's melee attack lines (2024 "Melee Attack Roll:", 2014 "Melee Weapon Attack:"). */
function reachFromText(fullText: string): number | null {
  let best: number | null = null;
  for (const line of fullText.replace(/[*_]/g, '').split('\n')) {
    if (!/\bMelee\b[^.:]{0,30}?Attack(?: Roll)?\s*:/i.test(line)) continue;
    for (const m of line.matchAll(/\breach\s+(\d+)\s*(?:ft|feet)/gi)) best = Math.max(best ?? 0, Number(m[1]));
  }
  return best;
}

const optional = <T>(key: string, value: T | undefined | '') => (value === undefined || value === '' ? {} : { [key]: value });

export function normalizeMonster(wire: Wire<'monster'>, ctx: NormalizeContext): Normalized<'monster'> {
  const base = beginNormalize('a monster', wire, ctx, MONSTER_FIELDS);
  const w: RecordWarning[] = [];
  const adaptations = [];

  const sizes = [...new Set([...wire.sizeText.matchAll(SIZE_WORD)].map((m) => sizeOf(m[1])))];
  if (!sizes.length) w.push(missing('size', 'The size'));
  const { type, tags } = typeAndTags(wire.typeText);
  if (!type) w.push(missing('type', 'The creature type'));
  const ac = /^\s*(\d+)/.exec(wire.acText);
  if (!ac) w.push(missing('ac', 'The Armor Class'));
  const acNote = /\(([^)]*)\)/.exec(wire.acText)?.[1].trim();
  const hp = /^\s*(\d+)\s*(?:\(([^)]+)\))?/.exec(wire.hpText);
  if (!hp) w.push(missing('hp', 'The Hit Points'));
  const speeds = parseSpeeds(wire.speedText);
  if (!Object.keys(speeds).some((k) => k !== 'hover')) w.push(missing('speeds', 'The Speed'));
  const cr = parseCrLine(wire.crText);
  if (!cr || CR_VALUES[cr.cr] === undefined) w.push(missing('cr', 'The challenge rating'));
  const scores = wire.abilityScores;
  const abilitiesOk = ABILITY_KEYS.every((a) => Number.isInteger(scores[a]) && scores[a] >= 1);
  if (!abilitiesOk) w.push(missing('abilities', "The ability scores weren't found."));
  else {
    for (const a of ABILITY_KEYS) if (!numberInText(scores[a], base.fullText)) w.push(ungrounded(String(scores[a]), `abilities.${a}`));
  }

  if (!sizes.length || !type || !ac || !hp || !cr || CR_VALUES[cr.cr] === undefined || !abilitiesOk || !Object.keys(speeds).some((k) => k !== 'hover')) {
    return finishNormalize('monster', base, null, [], { matchesKind: wire.matchesKind, keyFields: KEY_FIELDS, ctx, extra: w });
  }

  const abilities: AbilityScores = { str: scores.str, dex: scores.dex, con: scores.con, int: scores.int, wis: scores.wis, cha: scores.cha };
  const pb = cr.pb ?? proficiencyBonusForCr(cr.crValue);
  const printedInitiative = /[+\-−–]\s?\d+/.exec(wire.initiativeText)?.[0];
  let initiative: number;
  if (printedInitiative) initiative = Number(printedInitiative.replace(/[−–]/, '-').replace(/\s/g, ''));
  else {
    initiative = abilityModifier(abilities.dex);
    w.push(warning('default-used', 'info', 'No Initiative line: the app used the Dexterity modifier.', 'initiative'));
  }
  if (wire.format === '2014') adaptations.push(adaptation('monster-2014-statblock', { name: base.name }));

  let reachFt = /(\d+)\s*(?:ft|feet)/i.exec(wire.reachText) ? Number(/(\d+)\s*(?:ft|feet)/i.exec(wire.reachText)![1]) : (reachFromText(base.fullText) ?? 5);
  reachFt = Math.min(60, Math.max(5, Math.round(reachFt / 5) * 5));

  const passive = /passive perception\s*(\d+)/i.exec(wire.sensesText)?.[1];
  const data: MonsterData = {
    format: wire.format,
    size: sizes[0],
    ...(sizes.length > 1 ? { sizes } : {}),
    type,
    ...(tags.length ? { tags } : {}),
    ...optional('alignment', wire.alignmentText ? titleCase(wire.alignmentText) : ''),
    ac: Number(ac[1]),
    ...optional('acNote', acNote),
    hp: Number(hp[1]),
    ...optional('hitDice', hp[2]?.trim()),
    speed: speedLine(speeds),
    speeds,
    initiative,
    reachFt,
    cr: cr.cr,
    crValue: cr.crValue,
    ...(/\bXP\b/i.test(wire.crText) ? { xp: cr.xp } : {}),
    pb,
    abilities,
    ...optional('senses', wire.sensesText.trim()),
    ...(passive ? { passivePerception: Number(passive) } : {}),
    ...optional('languages', wire.languagesText.trim()),
    ...optional('resistances', wire.resistancesText.trim()),
    ...optional('immunities', wire.immunitiesText.trim()),
    ...optional('vulnerabilities', wire.vulnerabilitiesText.trim()),
    legendary: wire.legendary,
  };
  const checks = monsterChecks(data, { printedInitiative: Boolean(printedInitiative), printedPb: cr.pb !== undefined });
  return finishNormalize('monster', base, data, adaptations, { matchesKind: wire.matchesKind, keyFields: KEY_FIELDS, ctx, extra: [...w, ...checks] });
}

/** Cross-checks and DM tool limits on the data (shared by normalize and validate). */
export function monsterChecks(data: MonsterData, opts: { printedInitiative: boolean; printedPb: boolean } = { printedInitiative: true, printedPb: true }): RecordWarning[] {
  const out: RecordWarning[] = [];
  const range = (field: string, value: number, min: number, max: number, label: string) => {
    if (!Number.isFinite(value) || value < min || value > max) {
      out.push(warning('out-of-range', 'block', `${label} ${value} is outside what combat and the DM's tools accept (${min}–${max}).`, field));
    }
  };
  range('ac', data.ac, 1, 40, 'AC');
  range('hp', data.hp, 1, 2000, 'HP');
  range('initiative', data.initiative, -10, 20, 'Initiative');
  range('reachFt', data.reachFt, 5, 60, 'Reach');
  for (const [mode, ft] of Object.entries(data.speeds)) {
    if (typeof ft === 'number' && ft > 200) out.push(warning('out-of-range', 'block', `A ${mode} speed of ${ft} ft. is more than the battle map handles (200).`, 'speeds'));
  }
  const expectedXp = XP_BY_CR[data.crValue];
  if (data.xp !== undefined && expectedXp !== undefined && data.crValue > 0 && data.xp !== expectedXp) {
    out.push(warning('cross-check', 'warn', `XP ${data.xp} doesn't match CR ${data.cr} (${expectedXp} XP).`, 'xp'));
  }
  const expectedPb = proficiencyBonusForCr(data.crValue);
  if (opts.printedPb && data.pb !== undefined && data.pb !== expectedPb) {
    out.push(warning('cross-check', 'warn', `PB +${data.pb} doesn't match CR ${data.cr} (+${expectedPb}).`, 'pb'));
  }
  const average = data.hitDice ? averageOf(data.hitDice) : null;
  if (average !== null && Math.abs(data.hp - average) > Math.max(2, average * 0.1)) {
    out.push(warning('cross-check', 'warn', `HP ${data.hp} isn't near the average of ${data.hitDice} (${average}).`, 'hp'));
  }
  if (opts.printedInitiative) {
    const dex = abilityModifier(data.abilities.dex);
    const pb = data.pb ?? expectedPb;
    if (![dex, dex + pb, dex + 2 * pb].includes(data.initiative)) {
      out.push(warning('cross-check', 'warn', `Initiative ${data.initiative >= 0 ? '+' : ''}${data.initiative} doesn't follow from its Dexterity (${dex >= 0 ? '+' : ''}${dex}).`, 'initiative'));
    }
  }
  return out;
}

export function validateMonster(data: MonsterData, ctx: NormalizeContext): Pick<Normalized<'monster'>, 'warnings' | 'adaptations' | 'confidence'> {
  void ctx;
  const warnings = monsterChecks(data);
  const adaptations = data.format === '2014' ? [adaptation('monster-2014-statblock', { name: '' })] : [];
  return { warnings, adaptations, confidence: gradeConfidence('monster', warnings, { matchesKind: true, missingKey: false }) };
}
