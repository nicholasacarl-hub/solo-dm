import { describe, expect, it, vi } from 'vitest';

vi.mock('@/engine', () => import('./testing/fakeEngine'));
vi.mock('@/data', () => import('./testing/fakeData'));
vi.mock('@/state/gameStore', () => import('./testing/fakeGameStoreModule'));

import { sampleCampaign, sampleCharacter, sampleClocks, sampleCombat, sampleJournal } from '@/test/fixtures';
import type { JournalEntry } from '@/types';
import { buildGameState, findMentionedEntries, mentions, MAX_ENTITY_CARDS, type GameStateInput } from './state';

function input(overrides: Partial<GameStateInput> = {}): GameStateInput {
  return {
    campaign: sampleCampaign(),
    character: sampleCharacter(),
    combat: null,
    clocks: sampleClocks(),
    journal: sampleJournal(),
    playerText: '',
    previousNarration: '',
    ...overrides,
  };
}

describe('mentions', () => {
  it('matches whole words, case-insensitively', () => {
    expect(mentions('I ask old tam about it', 'Old Tam')).toBe(true);
    expect(mentions('Old  Tam, are you there?', 'Old Tam')).toBe(true);
    expect(mentions('I ask Old Tamsin', 'Old Tam')).toBe(false);
    expect(mentions('Ask the dockhand', 'dockhand')).toBe(true);
    expect(mentions('a', 'Al')).toBe(false);
  });
});

describe('buildGameState', () => {
  it('has the hero status, scene, tension and open clocks', () => {
    const block = buildGameState(input());
    expect(block.startsWith('<game_state>\n')).toBe(true);
    expect(block.endsWith('\n</game_state>')).toBe(true);
    expect(block).toContain('Hero: Mira Voss (Wizard 3) · HP 12/17');
    expect(block).toContain('Scene: Saltmarsh Docks · dusk · fog rolling in · mood: uneasy · Tension 5/9');
    expect(block).toContain('Clocks: Something stirs below 2/6 (threat, secret) · The tide turns 1/4 (countdown)');
    expect(block).not.toContain('Combat:');
    expect(block).not.toContain('Mentioned');
  });

  it('adds the combat summary when a fight is on', () => {
    expect(buildGameState(input({ combat: sampleCombat() }))).toMatch(/Combat:\nRound 2/);
  });

  it('adds cards for journal entries named in the player text or the last narration, secrets marked', () => {
    const block = buildGameState(
      input({ playerText: 'I ask Tam about Keeper Halvard.', previousNarration: 'The drowned lantern burns green.' }),
    );
    expect(block).toContain('- Keeper Halvard (NPC, missing) [secret]: The missing keeper.');
    expect(block).toContain('- The Drowned Lantern (Location): The abandoned lighthouse');
    expect(block).not.toContain('Old Tam (NPC');
  });

  it('matches tags as aliases and caps the number of cards', () => {
    expect(findMentionedEntries(sampleJournal(), 'Where is the witness?', '').map((j) => j.name)).toEqual(['Old Tam']);
    const many: JournalEntry[] = Array.from({ length: 10 }, (_, i) => ({ ...sampleJournal()[0], id: `n${i}`, name: `Sailor ${i + 1}`, tags: [] }));
    const text = many.map((j) => j.name).join(', ');
    expect(findMentionedEntries(many, text, '')).toHaveLength(MAX_ENTITY_CARDS);
  });

  it('ranks names the player used, then names in the narration, then tag aliases', () => {
    const found = findMentionedEntries(sampleJournal(), 'Old Tam', 'Keeper Halvard and the lighthouse');
    expect(found.map((j) => j.name)).toEqual(['Old Tam', 'Keeper Halvard', 'The Drowned Lantern']);
  });
});
