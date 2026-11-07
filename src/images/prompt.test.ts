import { describe, expect, it } from 'vitest';
import type { ImageSubject, Transformation } from '@/types';
import { sampleCampaign, sampleCharacter, sampleSettings } from '@/test/fixtures';
import {
  ART_STYLE_PRESETS,
  DEFAULT_ART_STYLE,
  buildImagePrompt,
  campaignArtStyle,
  defaultArtStyle,
  describeHero,
  equippedGear,
  heroInFrame,
  portraitDescription,
  toneArtStylePreset,
} from './prompt';

const SUBJECTS: ImageSubject[] = ['scene', 'character', 'npc', 'creature', 'item', 'battle'];

describe('buildImagePrompt', () => {
  it('puts the art style first, then the framing, the description and the guardrails', () => {
    const prompt = buildImagePrompt({
      prompt: 'A lighthouse on a black cliff, its lantern burning green',
      subject: 'scene',
      artStyle: 'ink and wash, one accent color',
    });
    const parts = prompt.split('\n\n');
    expect(parts[0]).toBe('Art style: ink and wash, one accent color.');
    expect(parts[1]).toMatch(/wide establishing shot/i);
    expect(parts[2]).toBe('A lighthouse on a black cliff, its lantern burning green.');
    expect(parts.at(-1)).toMatch(/no user interface, frames or borders/i);
    for (const word of ['text', 'captions', 'watermarks', 'map']) expect(prompt.toLowerCase()).toContain(word);
  });

  it('frames every subject, and battles as action scenes rather than maps or grids', () => {
    const framings = SUBJECTS.map((subject) => buildImagePrompt({ prompt: 'x', subject }).split('\n\n')[1]);
    expect(new Set(framings).size).toBe(SUBJECTS.length - 1); // characters and NPCs share the portrait framing
    expect(framings[SUBJECTS.indexOf('character')]).toMatch(/portrait/i);
    expect(framings[SUBJECTS.indexOf('item')]).toMatch(/still life/i);
    expect(framings[SUBJECTS.indexOf('creature')]).toMatch(/creature/i);
    const battle = framings[SUBJECTS.indexOf('battle')];
    expect(battle).toMatch(/dynamic action scene/i);
    expect(battle).toMatch(/not a map, grid or top-down/i);
  });

  it('falls back to the house style and adds the hero and the topics to avoid when given', () => {
    const prompt = buildImagePrompt({
      prompt: 'The duel on the pier',
      subject: 'battle',
      artStyle: '   ',
      heroAppearance: 'Mira Voss (she/her), an elf wizard. Appearance: sea-glass earrings.',
      avoid: ['Gore', ' ', 'Spiders & insects'],
    });
    expect(prompt.startsWith(`Art style: ${DEFAULT_ART_STYLE}.`)).toBe(true);
    expect(prompt).toContain('The hero in this picture: Mira Voss (she/her), an elf wizard. Appearance: sea-glass earrings.');
    expect(prompt).toContain('Never show: Gore, Spiders & insects.');
  });

  it('keeps a runaway description from crowding out the guardrails', () => {
    const prompt = buildImagePrompt({ prompt: 'fog '.repeat(5000), subject: 'scene' });
    expect(prompt.length).toBeLessThan(3500);
    expect(prompt).toMatch(/Not a map, diagram, chart or game board\.$/);
  });
});

describe('art styles', () => {
  it('matches the tone presets and custom tones, with the house style when nothing fits', () => {
    expect(toneArtStylePreset('Grim & gritty: scarce resources, hard choices, wounds that linger.').id).toBe('gritty');
    expect(toneArtStylePreset('Cosmic horror: creeping dread and truths best left unknown.').id).toBe('eerie');
    expect(toneArtStylePreset('Fairy-tale whimsy: talking beasts, strange bargains, gentle wonder.').id).toBe('storybook');
    expect(toneArtStylePreset('Swashbuckling adventure: daring escapes, rivals and treasure maps.').id).toBe('adventure');
    expect(toneArtStylePreset('Political intrigue: factions, secrets, words sharper than swords.').id).toBe('courtly');
    expect(toneArtStylePreset('Heroic fantasy: bold heroes, high stakes, light winning out.').id).toBe('heroic');
    expect(toneArtStylePreset('Folk horror with a dry sense of humor').id).toBe('eerie');
    expect(defaultArtStyle('Slice of life in a sleepy port')).toBe(DEFAULT_ART_STYLE);
    expect(new Set(ART_STYLE_PRESETS.map((p) => p.id)).size).toBe(ART_STYLE_PRESETS.length);
  });

  it("uses the campaign's own art style, else the tone's", () => {
    expect(campaignArtStyle(sampleCampaign({ settings: { ...sampleSettings(), artStyle: ' woodcut print ' } }))).toBe('woodcut print');
    expect(campaignArtStyle(sampleCampaign())).toBe(defaultArtStyle(sampleSettings().tone));
  });
});

describe('the hero in pictures', () => {
  const vampirism: Transformation = {
    id: 'tr-1',
    name: 'Vampirism',
    summary: 'Hungry.',
    stage: 'Stage 1 of 3',
    origin: 'imposed',
    status: 'active',
    featureIds: [],
    startedSession: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  it('describes the hero from the sheet: name, pronouns, species, classes, look, changes and gear', () => {
    const hero = sampleCharacter({ transformations: [vampirism, { ...vampirism, id: 'tr-2', name: 'Old curse', status: 'ended' }] });
    const text = describeHero(hero);
    expect(text).toContain('Mira Voss (she/her), an elf (High Elf lineage) wizard (Evoker).');
    expect(text).toContain('Appearance: Ink-stained fingers, sea-glass earrings.');
    expect(text).toContain('Visibly marked by: Vampirism (Stage 1 of 3).');
    expect(text).not.toContain('Old curse');
    expect(text).toContain('Carrying or wearing: Dagger.');
    expect(text).not.toContain('Spellbook');
    expect(text).not.toContain('Answers questions');
    expect(describeHero(hero, { personality: true })).toContain('Personality, shown in expression and pose: Answers questions with more questions.');
  });

  it('mentions size and every class of a multiclass hero', () => {
    const hero = sampleCharacter({
      size: 'Small',
      species: 'Halfling',
      pronouns: undefined,
      classes: [
        { classId: 'srd:class:rogue', name: 'Rogue', level: 3, hitDie: 8, casterType: 'none' },
        { classId: 'srd:class:fighter', name: 'Fighter', level: 1, hitDie: 10, casterType: 'none' },
      ],
    });
    expect(describeHero(hero).startsWith('Mira Voss, a small halfling rogue and fighter.')).toBe(true);
  });

  it('lists equipped and attuned gear only', () => {
    const hero = sampleCharacter({
      inventory: [
        { id: '1', name: 'Longsword', quantity: 1, equipped: true },
        { id: '2', name: 'Ring of Warmth', quantity: 1, attuned: true },
        { id: '3', name: 'Rope', quantity: 1 },
      ],
    });
    expect(equippedGear(hero)).toEqual(['Longsword', 'Ring of Warmth']);
  });

  it('puts the hero in frame for their portrait and battles, or when the DM names them', () => {
    const hero = sampleCharacter();
    const ask = (subject: ImageSubject, prompt: string, extra: { heroInFrame?: boolean } = {}) =>
      heroInFrame({ subject, title: 'A picture', prompt, ...extra }, hero);
    expect(ask('character', 'A portrait')).toBe(true);
    expect(ask('battle', 'Goblins charge')).toBe(true);
    expect(ask('scene', 'Mira climbs the lighthouse stairs')).toBe(true);
    expect(ask('scene', 'MIRA VOSS at the door')).toBe(true);
    expect(ask('scene', 'Admiral Miranda on her flagship')).toBe(false);
    expect(ask('creature', 'A kraken rises')).toBe(false);
    expect(ask('battle', 'The armies clash far below', { heroInFrame: false })).toBe(false);
    expect(heroInFrame({ subject: 'character', title: '', prompt: '' }, null)).toBe(false);
  });

  it('describes a portrait with personality', () => {
    expect(portraitDescription(sampleCharacter())).toMatch(/^A portrait of Mira Voss .*Personality, shown in expression and pose/);
  });
});
