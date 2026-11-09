/**
 * Offline background parser (spec §3.9): the 2024 labels Ability Scores / Feat / Skill Proficiencies /
 * Tool Proficiency / Equipment (bullets, bold lines or the PDF layer's plain "Label: value" lines), and
 * the older layout's Skill Proficiencies / Tool Proficiencies / Languages / Equipment plus a
 * "Feature: Name" heading or run-in (kept as the background's legacy feature).
 *
 * Owner: E4. Pure.
 */
import type { CandidateBlock, Candidate } from '../segment';
import type { Wire } from '../wire';
import type { OfflineParse } from './index';
import { findLabel, plainText, runInParts } from './srdRulesOptions';

const FEATURE_TITLE = /^Feature\s*:\s*(.+)$/i;

/** The background's named feature: a block titled "Feature: X", or a "Feature: X" run-in / heading inside one. */
function legacyFeature(blocks: readonly CandidateBlock[]): Wire<'background'>['legacyFeature'] {
  for (const block of blocks) {
    const titled = FEATURE_TITLE.exec(block.title);
    if (titled && block.paragraphs.length) return { name: titled[1].trim(), text: { block: block.id, from: 1, to: block.paragraphs.length } };
  }
  for (const block of blocks) {
    for (const part of runInParts(block.paragraphs)) {
      const m = FEATURE_TITLE.exec(part.label);
      if (m) return { name: m[1].trim(), text: { block: block.id, from: part.from, to: part.to } };
    }
    const heading = block.paragraphs.findIndex((p) => /^#{1,6}\s+Feature\s*:/i.test(p));
    if (heading >= 0 && heading + 1 < block.paragraphs.length) {
      const next = block.paragraphs.findIndex((p, i) => i > heading && /^#{1,6}\s/.test(p));
      const name = plainText(block.paragraphs[heading]).replace(/^Feature\s*:\s*/i, '');
      return { name, text: { block: block.id, from: heading + 2, to: next < 0 ? block.paragraphs.length : next } };
    }
  }
  return { name: '', text: { block: '', from: 0, to: 0 } };
}

export function parseBackground(candidate: Candidate): OfflineParse<'background'> {
  const blocks = candidate.blocks;
  const get = (label: string) => findLabel(blocks, label)?.value.replace(/\.$/, '') ?? '';
  const wire: Wire<'background'> = {
    matchesKind: true,
    name: candidate.name,
    format: '2024',
    abilityScoresText: get('Ability Scores'),
    featText: get('Feat'),
    skillsText: get('Skill Proficiencies'),
    toolText: get('Tool Proficienc(?:y|ies)'),
    equipmentText: get('Equipment'),
    languagesText: get('Languages'),
    legacyFeature: legacyFeature(blocks),
    notes: '',
  };
  wire.format = wire.abilityScoresText || wire.featText ? '2024' : '2014';
  const keys: ('skillsText' | 'equipmentText' | 'abilityScoresText')[] = ['skillsText', 'equipmentText'];
  if (wire.format === '2024') keys.push('abilityScoresText');
  return { wire, missing: keys.filter((f) => !wire[f]) };
}
