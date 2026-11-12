/**
 * Text renderings of game state for the DM (system prompt snapshot, tool results, per-turn status).
 * Keep them compact and deterministic (stable ordering) — they feed the prompt cache.
 */
import { ABILITIES, SKILLS, SKILL_NAMES, type Character, type Feature, type InventoryItem, type KnownSpell, type SpellSlotLevel } from '@/types';
import { copiedTextMissing, wrapImported } from '@/lib/importedContent';
import { formatCurrency, totalGp } from './character';
import { conditionName } from './conditions';
import { xpSummary } from './progression';
import {
  abilityModifier,
  attackBonus,
  attackDamageExpression,
  characterLevel,
  eldritchBlastBeams,
  exhaustionLevel,
  formatModifier,
  initiativeModifier,
  passivePerception,
  proficiencyBonus,
  savingThrowModifier,
  skillModifier,
  speedDetails,
  spellAttackBonus,
  spellSaveDC,
  weaponCritRange,
} from './rules';
import { ordinal } from './spellcasting';
import { activeTransformations } from './transform';
import { formatInt } from './util';

const SLOT_LEVELS: readonly SpellSlotLevel[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * The most of one free-text field the DM's sheet carries: a personality field, the player's notes, a feature's
 * rules text. Real sheets stay far below it (a long backstory runs a few thousand characters, the longest SRD
 * feature about 3,000); it only keeps a pasted book from swelling every request of a session, and past it the
 * sheet says how much it left out. The frozen prompt and get_character_sheet render the same text.
 */
export const SHEET_TEXT_MAX = 20_000;

/**
 * Text as written: lines and paragraphs kept (a run of blank lines becomes one), a line's indent kept, runs of
 * spaces after a word and trailing spaces gone. Linear in the text (no pattern that backtracks over a long run).
 */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/(\S)[^\S\n]+/g, '$1 ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The text cut at SHEET_TEXT_MAX, at a paragraph, line or word end near it, and how many characters that left out. */
function capped(text: string): { kept: string; left: number } {
  if (text.length <= SHEET_TEXT_MAX) return { kept: text, left: 0 };
  const head = text.slice(0, SHEET_TEXT_MAX);
  const at = [head.lastIndexOf('\n\n'), head.lastIndexOf('\n'), head.lastIndexOf(' ')].find((i) => i > SHEET_TEXT_MAX * 0.8) ?? SHEET_TEXT_MAX;
  const kept = head.slice(0, at).trimEnd();
  return { kept, left: text.length - kept.length };
}

/** Every line after the first indented two spaces, so a multi-line text stays inside its list item. */
function indented(text: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 || line === '' ? line : `  ${line}`))
    .join('\n');
}

/** What a cut field says after its text. */
function leftOut(left: number): string {
  return left > 0 ? ` [${formatInt(left)} more characters are too long for this sheet; ask the player if you need the rest]` : '';
}

/** A free-text field for a list item, whole up to SHEET_TEXT_MAX; a one-line text is formatted as it always was. */
function fieldText(text: string): string {
  const { kept, left } = capped(tidy(text));
  return `${indented(kept)}${leftOut(left)}`;
}

function classText(c: Character): string {
  if (c.classes.length === 0) return 'no class yet';
  return c.classes.map((cl) => `${cl.name} ${cl.level}`).join(' / ');
}

function hpText(c: Character): string {
  return `HP ${c.hp.current}/${c.hp.max}${c.hp.temp > 0 ? ` (+${c.hp.temp} temp)` : ''}`;
}

function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** "Dying (death saves: 1 success, 2 failures)", "Stable at 0 HP", "DEAD", or null when conscious. */
function vitalText(c: Character): string | null {
  if (c.deathSaves.dead) return 'DEAD';
  if (c.hp.current > 0 || c.hp.max <= 0) return null;
  if (c.deathSaves.stable) return 'Stable at 0 HP';
  const { successes, failures } = c.deathSaves;
  return `Dying (death saves: ${plural(successes, 'success', 'successes')}, ${plural(failures, 'failure')})`;
}

function slotsText(c: Character): string | null {
  const sc = c.spellcasting;
  if (!sc) return null;
  const parts = SLOT_LEVELS.flatMap((level) => {
    const t = sc.slots[level];
    return t && t.max > 0 ? [`${ordinal(level)} ${t.max - t.used}/${t.max}`] : [];
  });
  if (sc.pact && sc.pact.slots.max > 0) {
    parts.push(`Pact ${sc.pact.slots.max - sc.pact.slots.used}/${sc.pact.slots.max} (${ordinal(sc.pact.slotLevel)})`);
  }
  return parts.length ? parts.join(', ') : null;
}

function hitDiceText(c: Character): string | null {
  if (c.hitDice.length === 0) return null;
  return c.hitDice.map((h) => `${h.total - h.spent}/${h.total} d${h.die}`).join(', ');
}

function conditionsText(c: Character): string | null {
  if (c.conditions.length === 0) return null;
  return c.conditions.map((x) => conditionName(x.id)).join(', ');
}

/**
 * One- or two-line status, e.g.
 * "Mira (Wizard 3) · HP 14/20 (+5 temp) · AC 12 · Slots 1st 2/4, 2nd 1/2 · Hit Dice 2/3 d6 ·
 *  Conditions: Poisoned · Exhaustion 1 · Concentrating: Fly · Inspiration"
 */
export function characterStatusLine(c: Character): string {
  const parts = [`${c.name.trim() || 'Unnamed hero'} (${classText(c)})`, hpText(c)];
  const vital = vitalText(c);
  if (vital) parts.push(vital);
  parts.push(`AC ${c.armorClass}`);
  const speed = speedDetails(c);
  if (speed.speed !== speed.base) parts.push(`Speed ${speed.speed} ft`);
  const slots = slotsText(c);
  if (slots) parts.push(`Slots ${slots}`);
  const dice = hitDiceText(c);
  if (dice) parts.push(`Hit Dice ${dice}`);
  const conditions = conditionsText(c);
  if (conditions) parts.push(`Conditions: ${conditions}`);
  const exhaustion = exhaustionLevel(c);
  if (exhaustion > 0) parts.push(`Exhaustion ${exhaustion}`);
  if (c.spellcasting?.concentratingOn) parts.push(`Concentrating: ${c.spellcasting.concentratingOn}`);
  if (c.heroicInspiration) parts.push('Heroic Inspiration');
  const transformations = activeTransformations(c);
  if (transformations.length) parts.push(`Transformations: ${transformations.map((t) => `${t.name}${t.stage ? ` (${t.stage})` : ''}`).join(', ')}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Full sheet
// ---------------------------------------------------------------------------

const PROF_LABEL: Record<number, string> = { 0.5: ' (half)', 1: ' (prof)', 2: ' (expertise)' };

function headerLines(c: Character): string[] {
  const classes = c.classes.map((cl) => `${cl.name} ${cl.level}${cl.subclass ? ` (${cl.subclass})` : ''}`).join(' / ') || 'no class yet';
  const level = c.classes.length > 1 ? `Level ${characterLevel(c)}: ` : '';
  const title = `## ${c.name.trim() || 'Unnamed hero'} — ${level}${classes}`;
  const origin = [c.species, c.background && `${c.background} background`, c.alignment, c.pronouns, c.size, xpSummary(c)].filter(
    (x): x is string => !!x && x.trim() !== '',
  );
  return [title, origin.join(' · ')];
}

function vitalsLines(c: Character): string[] {
  const speed = speedDetails(c);
  const speedText = `${speed.speed} ft${speed.notes.length ? ` (${speed.notes.join('; ')})` : ''}`;
  const others = Object.entries(c.otherSpeeds ?? {})
    .filter(([, v]) => (v ?? 0) > 0)
    .map(([k, v]) => `${k} ${v} ft`);
  const first = [
    `**${hpText(c)}**`,
    `**AC** ${c.armorClass}${c.acFormula ? ` (${c.acFormula})` : ''}`,
    `**Speed** ${speedText}${others.length ? `, ${others.join(', ')}` : ''}`,
    `**Initiative** ${formatModifier(initiativeModifier(c))}`,
    `**Proficiency Bonus** ${formatModifier(proficiencyBonus(characterLevel(c)))}`,
    `**Passive Perception** ${passivePerception(c)}`,
  ];
  if (c.darkvision) first.push(`Darkvision ${c.darkvision} ft`);
  const second = [`**Hit Point Dice** ${hitDiceText(c) ?? 'none'}`, `**Heroic Inspiration** ${c.heroicInspiration ? 'yes' : 'no'}`];
  const exhaustion = exhaustionLevel(c);
  if (exhaustion > 0) second.push(`**Exhaustion** ${exhaustion} (${formatModifier(-2 * exhaustion)} to D20 Tests)`);
  const vital = vitalText(c);
  if (vital) second.push(`**${vital}**`);
  second.push(`**Conditions** ${conditionsText(c) ?? 'none'}`);
  return [first.join(' · '), second.join(' · ')];
}

function abilityLines(c: Character): string[] {
  const scores = ABILITIES.map((a) => `${a.toUpperCase()} ${c.abilityScores[a]} (${formatModifier(abilityModifier(c.abilityScores[a]))})`);
  const saves = ABILITIES.map((a) => `${a.toUpperCase()} ${formatModifier(savingThrowModifier(c, a))}${c.savingThrows.includes(a) ? ' (prof)' : ''}`);
  const skills = SKILLS.map((s) => `${SKILL_NAMES[s]} ${formatModifier(skillModifier(c, s))}${PROF_LABEL[c.skills[s] ?? 0] ?? ''}`);
  return [`**Abilities:** ${scores.join(' · ')}`, `**Saving throws:** ${saves.join(' · ')}`, `**Skills:** ${skills.join(' · ')}`];
}

function proficiencyLine(c: Character): string {
  const list = (items: readonly string[] | undefined) => (items && items.length ? items.join(', ') : 'none');
  const parts = [
    `Weapons: ${list(c.weaponProficiencies)}`,
    `Armor: ${list(c.armorTraining)}`,
    `Tools: ${list(c.tools)}`,
    `Languages: ${list(c.languages)}`,
  ];
  if (c.weaponMasteries?.length) parts.push(`Weapon Mastery: ${c.weaponMasteries.join(', ')}`);
  return `**Proficiencies:** ${parts.join('. ')}.`;
}

function attackLines(c: Character): string[] {
  if (c.attacks.length === 0) return [];
  const critRange = weaponCritRange(c);
  const lines = c.attacks.map((a) => {
    const beams = eldritchBlastBeams(c, a);
    const extras = [
      a.range,
      a.properties?.length ? a.properties.join(', ') : '',
      a.mastery ? `Mastery: ${a.mastery}` : '',
      a.notes ?? '',
      beams && beams > 1 ? `${beams} beams at this level (one attack roll each)` : '',
      critRange < 20 && a.ability !== 'spell' ? `Critical Hit on ${critRange}–20` : '',
    ]
      .filter((x): x is string => !!x && x.trim() !== '')
      .map((x) => x.trim());
    const damage = `${attackDamageExpression(c, a)} ${a.damageType}`.trim();
    return `- **${a.name}** ${formatModifier(attackBonus(c, a))} to hit, ${damage}${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
  });
  return ['### Attacks', ...lines];
}

function spellTags(spell: KnownSpell, classNames: Set<string>): string {
  const tags: string[] = [];
  if (spell.ritual) tags.push('R');
  if (spell.concentration) tags.push('C');
  if (spell.alwaysPrepared) tags.push('always prepared');
  else if (spell.level > 0 && !spell.prepared) tags.push('not prepared');
  if (spell.source && !classNames.has(spell.source.toLowerCase())) tags.push(spell.source);
  if (spell.homebrewId) tags.push('homebrew');
  return tags.length ? ` (${tags.join(', ')})` : '';
}

function spellcastingLines(c: Character): string[] {
  const sc = c.spellcasting;
  if (!sc) return [];
  const abilities = [...new Set([sc.ability, ...c.classes.flatMap((cl) => (cl.casterType !== 'none' && cl.spellcastingAbility ? [cl.spellcastingAbility] : []))])];
  const stats = abilities.map((a) => `${a.toUpperCase()}: save DC ${spellSaveDC(c, a)}, spell attack ${formatModifier(spellAttackBonus(c, a) ?? 0)}`);
  const header = [stats.join('; '), `Slots: ${slotsText(c) ?? 'none'}`, `Concentrating: ${sc.concentratingOn ?? 'nothing'}`];
  const classNames = new Set(c.classes.map((cl) => cl.name.toLowerCase()));
  const byLevel = new Map<number, KnownSpell[]>();
  const byName = (a: KnownSpell, b: KnownSpell) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0; // code-point order: identical in every browser
  };
  for (const spell of [...sc.spells].sort((a, b) => a.level - b.level || byName(a, b))) {
    byLevel.set(spell.level, [...(byLevel.get(spell.level) ?? []), spell]);
  }
  const lines = [...byLevel.entries()].map(
    ([level, spells]) => `- ${level === 0 ? 'Cantrips' : `Level ${level}`}: ${spells.map((s) => `${s.name}${spellTags(s, classNames)}`).join(', ')}`,
  );
  return ['### Spellcasting', header.join(' · '), ...lines];
}

const RECHARGE_TEXT: Record<string, string> = { short: 'short rest', long: 'long rest', dawn: 'dawn', turn: 'turn', none: 'total' };

/**
 * A feature's description for the DM, whole (fieldText). Text copied from an imported book (ref.textCopied) is
 * wrapped as one passage, after any cut at SHEET_TEXT_MAX, so exports can remove all of it (spec §7.2); a
 * placeholder (text left out of a save) says how to get it back. A ruling the DM wrote over a pulled placeholder
 * shows as written, though its ref still says `redacted`.
 */
function featureDescription(f: Feature): string {
  const d = f.description?.trim();
  if (!d) return '';
  if (!f.ref?.textCopied) return `: ${fieldText(d)}`;
  if (copiedTextMissing(f)) {
    return `: (text from the player's book “${f.ref.sourceTitle}” isn't on this device — call get_character_sheet after they import it, or rule from the name)`;
  }
  const { kept, left } = capped(tidy(d));
  return `: ${indented(wrapImported(f.ref.sourceTitle, kept))}${leftOut(left)}`;
}

function featureLine(f: Feature): string {
  const source = f.source === 'transformation' ? `transformation: ${f.sourceName ?? 'unnamed'}` : (f.sourceName ?? '');
  const meta = [source, f.uses ? `${f.uses.max - f.uses.used}/${f.uses.max} per ${RECHARGE_TEXT[f.uses.recharge] ?? f.uses.recharge}` : '', f.homebrewId ? 'homebrew' : '']
    .filter((x) => x.trim() !== '')
    .join('; ');
  return `- **${f.name}**${meta ? ` (${meta})` : ''}${featureDescription(f)}`;
}

/** The app's notes on older-format (2014) options this character uses; only when there are any. */
function adaptationLines(c: Character): string[] {
  const notes = (c.adaptationNotes ?? []).map((n) => n.trim()).filter(Boolean);
  return notes.length ? ['### Older-edition options (app notes)', ...notes.map((n) => `- ${n}`)] : [];
}

function itemText(i: InventoryItem): string {
  const tags = [
    i.equipped ? 'equipped' : '',
    i.attuned ? 'attuned' : '',
    i.magic && !i.attuned ? 'magic' : '',
    i.charges ? `${i.charges.max - i.charges.used}/${i.charges.max} charges` : '',
  ].filter(Boolean);
  return `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ''}${tags.length ? ` (${tags.join(', ')})` : ''}`;
}

function equipmentLines(c: Character): string[] {
  const gp = totalGp(c.currency);
  const coins = `**Coins:** ${formatCurrency(c.currency)}${gp > 0 ? ` (${Number.isInteger(gp) ? gp : gp.toFixed(2)} gp total)` : ''}`;
  const items = c.inventory.length ? c.inventory.map(itemText).join(' · ') : 'nothing';
  return ['### Equipment', items, coins];
}

/** What the player wrote about the hero, whole: the DM's main material for the story. */
function personalityLines(c: Character): string[] {
  const p = c.personality ?? {};
  const fields: Array<[string, string | undefined]> = [
    ['Traits', p.traits],
    ['Ideals', p.ideals],
    ['Bonds', p.bonds],
    ['Flaws', p.flaws],
    ['Appearance', p.appearance],
    ['Backstory', p.backstory],
    ['Player notes', c.notes],
  ];
  const lines = fields.flatMap(([label, value]) => (value?.trim() ? [`- ${label}: ${fieldText(value)}`] : []));
  return lines.length ? ['### Personality', ...lines] : [];
}

/** "**Defenses:** Resistance: fire · Condition immunity: Poisoned", or null when there are none. */
function defensesLine(c: Character): string | null {
  const parts = [
    ['Resistance', c.damageResistances],
    ['Immunity', c.damageImmunities],
    ['Vulnerability', c.damageVulnerabilities],
    ['Condition immunity', c.conditionImmunities],
  ]
    .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].length > 0)
    .map(([label, list]) => `${label}: ${list.join(', ')}`);
  return parts.length ? `**Defenses:** ${parts.join(' · ')}` : null;
}

/** Lasting changes to the hero: active ones in full, ended ones as a short history line. */
function transformationLines(c: Character): string[] {
  const all = c.transformations ?? [];
  if (all.length === 0) return [];
  const active = all.filter((t) => t.status === 'active').map((t) => {
    const meta = [t.stage, t.origin === 'accepted' ? 'chosen' : 'imposed', `since session ${t.startedSession}`].filter(Boolean).join('; ');
    const ends = t.howItEnds?.trim() ? ` How it could end: ${fieldText(t.howItEnds)}` : '';
    return `- **${t.name}** (${meta}): ${fieldText(t.summary)}${ends}`;
  });
  const ended = all.filter((t) => t.status === 'ended').map((t) => `${t.name}${t.endedSession ? ` (ended in session ${t.endedSession})` : ''}`);
  return ['### Transformations', ...active, ...(ended.length ? [`- Ended: ${ended.join(', ')}`] : [])];
}

/** Full character sheet as compact markdown for the DM (abilities, saves, skills, attacks, spells, features, inventory, money). */
export function characterSheetText(c: Character): string {
  const defenses = defensesLine(c);
  const sections: string[][] = [
    [...headerLines(c), '', ...vitalsLines(c)],
    [...abilityLines(c), proficiencyLine(c), ...(defenses ? [defenses] : [])],
    transformationLines(c),
    attackLines(c),
    spellcastingLines(c),
    c.features.length ? ['### Features', ...c.features.map(featureLine)] : [],
    adaptationLines(c),
    equipmentLines(c),
    personalityLines(c),
  ];
  return sections
    .filter((s) => s.length > 0)
    .map((s) => s.join('\n'))
    .join('\n\n');
}
