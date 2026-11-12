/**
 * The hero's sheet in the frozen system prompt, on the real engine: long text the player wrote and each feature's
 * rules text reach the DM whole at session start, rendered exactly as get_character_sheet renders them.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/data', () => import('./testing/fakeData'));
vi.mock('@/state/gameStore', () => import('./testing/fakeGameStoreModule'));

import { characterSheetText } from '@/engine';
import { sampleCampaign, sampleCharacter } from '@/test/fixtures';
import type { Character } from '@/types';
import { buildSystemPrompt } from './prompts';

// Invented: four paragraphs of backstory and long ideals, past the old 500- and 200-character cuts.
const BACKSTORY = [
  'Kestrel Vane grew up on the salt flats east of Harrowmere, where the caravans stop only to water their oxen.',
  'His mother traded rope and lamp oil; his father was a story she told on cold nights, a sellsword who never came back from the pass.',
  "At twelve he found a dragon's shed scale half buried in the flats, warm as a hearthstone in his hand. He swore an oath over it: one day he will become a dragon himself, scales and wings and all.",
  'He fights with twin hooked blades joined by a length of black chain, a gift from the smith who taught him to throw them.',
];
const IDEALS =
  'Transformation. Anything worth having is worth changing yourself to reach, and a person who stays the same out of fear has already lost. Freedom. No chain holds me that I did not forge myself. Loyalty to the few who stayed.';
const INNATE = [
  'An event in your past left an indelible mark on you, infusing you with simmering magic. As a Bonus Action, you can unleash that magic for 1 minute, during which the spell save DC of your Sorcerer spells increases by 1.',
  'You can use this feature twice, and you regain all expended uses of it when you finish a Long Rest.',
];

describe('the hero in the frozen system prompt', () => {
  it("carries the player's long text and each feature's text whole, as get_character_sheet does", () => {
    const base = sampleCharacter();
    const character: Character = {
      ...base,
      personality: { ...base.personality, backstory: BACKSTORY.join('\n\n'), ideals: IDEALS },
      features: [{ id: 'f-innate', name: 'Innate Sorcery', source: 'class', sourceName: 'Sorcerer 1', description: INNATE.join('\n\n') }],
    };
    const prompt = buildSystemPrompt({
      campaign: sampleCampaign(),
      character,
      sessions: [],
      sessionNumber: 1,
      quests: [],
      journal: [],
      clocks: [],
      homebrew: [],
      combat: null,
      librarySources: [],
    });
    expect(prompt).toContain(`## The hero (sheet at the start of this session)\n${characterSheetText(character).trim()}\n\n`);
    expect(prompt).toContain(`- Backstory: ${BACKSTORY.join('\n\n  ')}`);
    expect(prompt).toContain(`- Ideals: ${IDEALS}`);
    expect(prompt).toContain(`- **Innate Sorcery** (Sorcerer 1): ${INNATE.join('\n\n  ')}`);
    expect(prompt).not.toContain('worth changing yourself to reach, and a person who stays…');
  });
});
