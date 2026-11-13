/**
 * Text renderings of game state for the DM (system prompt snapshot, tool results, per-turn status).
 * Keep them compact and deterministic (stable ordering) — they feed the prompt cache.
 */
import { ABILITIES, SKILLS, SKILL_NAMES, type Character, type Feature, type InventoryItem, type KnownSpell, type SpellSlotLevel } from '@/types';
import { closeCutWrapper, copiedTextMissing, wrapImported } from '@/lib/importedContent';
import { codePoints, safeEnd } from '@/lib/text';
import { formatCurrency, totalGp } from './character';
import { conditionDetails, conditionName } from './conditions';
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
  saveBonusSources,
  savingThrowModifier,
  skillModifier,
  speedDetails,
  spellAttackBonus,
  spellSaveDC,
  weaponCritRange,
} from './rules';
import { ordinal } from './spellcasting';
import { activeTransformations } from './transform';
import { formatInt, toInt } from './util';

const SLOT_LEVELS: readonly SpellSlotLevel[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * The most of one free-text field the DM's sheet carries: a personality field, the player's notes, a feature's
 * rules text, an item's description. Real sheets stay far below it (a long backstory runs a few thousand
 * characters, the longest SRD feature about 4,300: Wizard Spellcasting); it only keeps a pasted book from
 * swelling every request of a session, and past it the sheet says how much it left out. The frozen prompt and
 * get_character_sheet render the same text.
 */
export const SHEET_TEXT_MAX = 20_000;

/**
 * Text as written: lines and paragraphs kept (a run of blank lines becomes one; a vertical tab, form feed or line
 * separator is a line break, a paragraph separator a blank line), a line's indent kept, runs of spaces after a word
 * and trailing spaces gone. A Markdown heading inside the text becomes a bold line, so it can't read as a section of
 * the sheet or the prompt around it. Linear in the text (no pattern that backtracks over a long run).
 */
function tidy(text: string): string {
  return text
    .replace(/\r\n?|[\v\f\u2028]/g, '\n')
    .replace(/\u2029/g, '\n\n')
    .split('\n')
    .map((line) => line.replace(/(\S)[^\S\n]+/g, '$1 ').trimEnd().replace(/^([^\S\n]*)#{1,6}[^\S\n]+(\S.*)$/, '$1**$2**'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The text cut at SHEET_TEXT_MAX, at a paragraph, line or word end near it and never between the halves of an
 * emoji, and how many characters (code points) that left out.
 */
function capped(text: string): { kept: string; left: number } {
  if (text.length <= SHEET_TEXT_MAX) return { kept: text, left: 0 };
  const head = text.slice(0, SHEET_TEXT_MAX);
  const end = [head.lastIndexOf('\n\n'), head.lastIndexOf('\n'), head.lastIndexOf(' ')].find((i) => i > SHEET_TEXT_MAX * 0.8) ?? SHEET_TEXT_MAX;
  const kept = text.slice(0, safeEnd(text, end)).trimEnd();
  return { kept, left: codePoints(text.slice(kept.length).trim()) };
}

/** Every line after the first indented two spaces, so a multi-line text stays inside its list item. */
function indented(text: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 || line === '' ? line : `  ${line}`))
    .join('\n');
}

/**
 * What a cut field says after its text. A book's text points to the book, not to the player: a player who pasted
 * the rest into the chat would put the book's words in the transcript, unwrapped.
 */
function leftOut(left: number, book = false): string {
  if (left <= 0) return '';
  return book
    ? ` [the last ${formatInt(left)} characters of the book's text didn't fit on this sheet; rule from what is here, or read the entry with get_entry]`
    : ` [the last ${formatInt(left)} characters didn't fit on this sheet; ask the player if you need them]`;
}

/**
 * A free-text field for a list item, whole up to SHEET_TEXT_MAX; a one-line text is formatted as it always was. A
 * cut inside a passage the field quotes from a book (its wrapper) closes it, so a copy leaves out that passage only.
 */
function fieldText(text: string): string {
  const { kept, left } = capped(tidy(text));
  return `${indented(left ? closeCutWrapper(kept) : kept)}${leftOut(left)}`;
}

/**
 * Whether the DM's sheet cuts this field (past SHEET_TEXT_MAX once tidied, as the sheet measures it). Tidying at
 * most doubles a text (a paragraph separator becomes a blank line), so a text half that long is never cut.
 */
export function sheetCutsText(text: string | undefined): boolean {
  if (!text || text.length * 2 <= SHEET_TEXT_MAX) return false;
  return capped(tidy(text)).left > 0;
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

/** "Frightened (until the end of your next turn; Ghost), Prone": with the details each was set with. */
function conditionsText(c: Character): string | null {
  if (c.conditions.length === 0) return null;
  return c.conditions.map((x) => `${conditionName(x.id)}${conditionDetails(x)}`).join(', ');
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
  // What every save adds, by name, so the DM can set one aside when a condition in an item's text doesn't hold.
  const sources = saveBonusSources(c).map((s) => `${s.name} ${formatModifier(s.bonus)}`);
  const included = sources.length ? ` (each includes ${sources.join(', ')})` : '';
  const skills = SKILLS.map((s) => `${SKILL_NAMES[s]} ${formatModifier(skillModifier(c, s))}${PROF_LABEL[c.skills[s] ?? 0] ?? ''}`);
  return [`**Abilities:** ${scores.join(' · ')}`, `**Saving throws:** ${saves.join(' · ')}${included}`, `**Skills:** ${skills.join(' · ')}`];
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
  const lines = [...byLevel.entries()].flatMap(([level, spells]) => [
    `- ${level === 0 ? 'Cantrips' : `Level ${level}`}: ${spells.map((s) => `${s.name}${spellTags(s, classNames)}`).join(', ')}`,
    ...spells.flatMap((s) => spellNotesLine(s) ?? []),
  ]);
  return ['### Spellcasting', header.join(' · '), ...lines];
}

/**
 * A spell's notes (the DM's spells_add notes, the builder's notes on a feat's or a species' spell), on one line under
 * its level. Notes that repeat a book's words (ref.textCopied) are wrapped like copied text, so exports remove them;
 * notes a save left out are not shown (the book can't give back the DM's words).
 */
function spellNotesLine(s: KnownSpell): string | null {
  const notes = s.notes?.replace(/\s+/g, ' ').trim();
  if (!notes) return null;
  if (!s.ref?.textCopied) return `  - ${s.name}: ${notes}`;
  if (copiedTextMissing({ description: notes, ref: s.ref })) return null;
  return `  - ${s.name}: ${wrapImported(s.ref.sourceTitle, notes).split('\n').join('\n    ')}`;
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
  return `: ${indented(wrapImported(f.ref.sourceTitle, kept))}${leftOut(left, true)}`;
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

/**
 * "+1 to attack and damage rolls with it, not counted by the app": a magic item's attack and damage bonuses, which the
 * engine never adds to the hero's attacks (the DM adds them), or null when it has none or needs an attunement it
 * lacks. A weapon the hero carries counts whether or not the sheet marks it equipped: the DM sees when it is wielded.
 */
function uncountedBonusText(i: InventoryItem): string | null {
  const attack = Math.max(0, toInt(i.bonuses?.attack));
  const damage = Math.max(0, toInt(i.bonuses?.damage));
  if ((!attack && !damage) || (i.requiresAttunement && !i.attuned)) return null;
  const rolls =
    attack === damage ? `${formatModifier(attack)} to attack and damage rolls` : [attack ? `${formatModifier(attack)} to attack rolls` : '', damage ? `${formatModifier(damage)} to damage rolls` : ''].filter(Boolean).join(', ');
  return `${rolls} with it, not counted by the app`;
}

function itemText(i: InventoryItem): string {
  const tags = [
    i.equipped ? 'equipped' : '',
    i.attuned ? 'attuned' : '',
    i.magic && !i.attuned ? 'magic' : '',
    i.charges ? `${i.charges.max - i.charges.used}/${i.charges.max} charges` : '',
    uncountedBonusText(i) ?? '',
  ].filter(Boolean);
  return `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ''}${tags.length ? ` (${tags.join(', ')})` : ''}`;
}

/**
 * An item's description, whole, wherever someone other than the app may have written it: a custom item the player or
 * the DM made, the DM's words on an SRD magic item or a homebrew item (the app writes none there), or the DM's own words
 * on a book's item (ref.textCopied), wrapped like copied text. A book's item linked without the DM's words (the builder,
 * the sheet's Add item form, inventory_add) gets a line naming the book and get_entry, then its app-written line,
 * numbers only: nothing else on the sheet says which items to read, and with the book switched off that line is all
 * there is. Non-magic SRD gear is left to get_entry: its description may be the SRD's own text, which the app copied
 * (so the DM's words on plain gear stay off the sheet; its rulings go to the journal).
 */
function itemDescriptionLine(i: InventoryItem): string | null {
  const d = i.description?.trim();
  // Linked, not described: the description is describeOption's (inventoryFromOption, inventoryFromEntry), never the
  // book's words, so it needs no wrapper; the DM's words on the item would have marked the ref copied.
  if (i.ref && !i.ref.textCopied) return `- **${i.name}** (${i.ref.sourceTitle}; read it with get_entry)${d ? `: ${fieldText(d)}` : ''}`;
  if (!d) return null;
  if (i.ref) {
    if (copiedTextMissing(i)) return null;
    const { kept, left } = capped(tidy(d));
    return `- **${i.name}**: ${indented(wrapImported(i.ref.sourceTitle, kept))}${leftOut(left, true)}`;
  }
  if (i.compendiumId && !i.compendiumId.startsWith('hb:') && !i.magic) return null;
  return `- **${i.name}**: ${fieldText(d)}`;
}

function equipmentLines(c: Character): string[] {
  const gp = totalGp(c.currency);
  const coins = `**Coins:** ${formatCurrency(c.currency)}${gp > 0 ? ` (${Number.isInteger(gp) ? gp : gp.toFixed(2)} gp total)` : ''}`;
  const items = c.inventory.length ? c.inventory.map(itemText).join(' · ') : 'nothing';
  const described = c.inventory.flatMap((i) => itemDescriptionLine(i) ?? []);
  return ['### Equipment', items, ...described, coins];
}

/**
 * "Saving throws now include Cloak of the Fen +1": what every save adds (saveBonusSources) after a change that altered
 * it, for a tool result or a notice; null when it didn't change. The frozen sheet's Saving throws line dates from the
 * start of the session, so this is how the DM hears of a bonus it may need to set aside mid-session (its "Bonuses"
 * rule).
 */
export function saveSourcesChangeText(before: Character, after: Character): string | null {
  const list = (c: Character) => saveBonusSources(c).map((s) => `${s.name} ${formatModifier(s.bonus)}`).join(', ');
  const was = list(before);
  const now = list(after);
  if (was === now) return null;
  return now ? `Saving throws now include ${now}` : `Saving throws no longer include ${was}`;
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
