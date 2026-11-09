/**
 * Older-format (2014) adaptations (spec §5.6): every code's exact, app-written note, filled from the
 * option's fields; 2024 options get none. Invented names only.
 */
import { describe, expect, it } from 'vitest';
import { ADAPTATION_NOTES, DUSK_DOMAIN_MERGE_ADAPTATIONS, EXPECTED_DATA, EXPECTED_ADAPTATIONS } from '@/test/structuredFixtures';
import type { AdaptationCode } from '@/types';
import { adaptation, adaptationNote, withAdaptations } from './adaptations';
import { backgroundAdaptations } from './normalize/background';
import { featAdaptations } from './normalize/feat';
import { speciesAdaptations } from './normalize/species';

describe('adaptationNote', () => {
  it('writes the notes that name the option', () => {
    const single: AdaptationCode[] = [
      'species-asi-not-applied', 'species-languages-suggested', 'background-any-three', 'background-feat-choice',
      'background-languages-suggested', 'feat-general', 'fighting-style-inline', 'subclass-at-level-1',
    ];
    for (const code of single) expect(adaptationNote(code, { name: 'Mossling' }), code).toBe(ADAPTATION_NOTES[code]('Mossling'));
    expect(adaptationNote('background-feature-kept', { name: 'Ferry Hand', feature: 'Ferryman’s Right' })).toBe(
      'Older edition: its feature “Ferryman’s Right” is kept on your sheet as a background feature.',
    );
  });

  it('writes the subclass notes from the parent class', () => {
    expect(adaptation('subclass-early-features', { name: 'Dusk Domain', className: 'Cleric', level: 3 })).toEqual(DUSK_DOMAIN_MERGE_ADAPTATIONS[0]);
    expect(adaptation('subclass-overlap', { name: 'Dusk Domain', className: 'Cleric' })).toEqual(DUSK_DOMAIN_MERGE_ADAPTATIONS[1]);
  });

  it('writes the spellcasting and stat block notes', () => {
    expect(adaptationNote('prepared-2024-column', { name: 'Wickwright', caster: 'full' })).toBe('Prepared spells follow the 2024 progression for a full caster.');
    expect(adaptationNote('prepared-2024-column', { name: 'Wickwright', caster: 'half' })).toBe('Prepared spells follow the 2024 progression for a half caster.');
    expect(adaptationNote('half-caster-slots-2024', { name: 'Wickwright' })).toBe(ADAPTATION_NOTES['half-caster-slots-2024']('Wickwright'));
    expect(adaptationNote('monster-2014-statblock', { name: 'Bramble Hound' })).toBe(ADAPTATION_NOTES['monster-2014-statblock']('Bramble Hound'));
  });

  it('keeps the first of each code when merging lists', () => {
    const a = adaptation('feat-general', { name: 'A' });
    expect(withAdaptations([a], [adaptation('feat-general', { name: 'B' }), adaptation('subclass-at-level-1', { name: 'C' })]).map((x) => x.note)).toEqual([
      a.note,
      'C chooses its subclass at level 1: pick it in the builder.',
    ]);
  });
});

describe('the adaptations each option kind implies', () => {
  it('gives older options their notes and 2024 options none', () => {
    expect(speciesAdaptations('Bramblefolk', EXPECTED_DATA.Bramblefolk)).toEqual(EXPECTED_ADAPTATIONS.Bramblefolk);
    expect(speciesAdaptations('Mothkin', EXPECTED_DATA.Mothkin)).toEqual([]);
    expect(backgroundAdaptations('Ferry Hand', EXPECTED_DATA['Ferry Hand'])).toEqual(EXPECTED_ADAPTATIONS['Ferry Hand']);
    expect(backgroundAdaptations('Lamplighter', EXPECTED_DATA.Lamplighter)).toEqual([]);
    expect(featAdaptations('Lantern Bearer', EXPECTED_DATA['Lantern Bearer'])).toEqual([]);
    expect(featAdaptations('Lantern Bearer', { format: '2014', category: 'general' })).toEqual([adaptation('feat-general', { name: 'Lantern Bearer' })]);
  });
});
