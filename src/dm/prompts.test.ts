import { describe, expect, it, vi } from 'vitest';

vi.mock('@/engine', () => import('./testing/fakeEngine'));
vi.mock('@/data', () => import('./testing/fakeData'));
vi.mock('@/state/gameStore', () => import('./testing/fakeGameStoreModule'));

import {
  sampleCampaign,
  sampleCharacter,
  sampleClocks,
  sampleCombat,
  sampleJournal,
  sampleQuests,
  sampleSession,
} from '@/test/fixtures';
import type { HomebrewEntry } from '@/types';
import { buildSystemPrompt, DM_INSTRUCTIONS, type PromptInput } from './prompts';

function homebrew(name: string, status: 'active' | 'retired', campaignId: string | null = 'camp-1'): HomebrewEntry {
  return {
    id: `hb:${name}`,
    sourceId: 'homebrew',
    sourceName: 'Homebrew',
    kind: 'boon',
    name,
    summary: `${name} summary`,
    text: `${name} text`,
    campaignId,
    origin: 'dm',
    status,
    createdAt: 5,
    updatedAt: 6,
  };
}

function input(overrides: Partial<PromptInput> = {}): PromptInput {
  return {
    campaign: sampleCampaign({ settings: { ...sampleCampaign().settings, enabledSources: ['srd-5.2.1', 'lib-phb'] } }),
    character: sampleCharacter(),
    sessions: [
      sampleSession({ id: 's2', number: 2, status: 'ended', recap: 'You reached the breakwater.', dmNotes: 'Halvard is below.' }),
      sampleSession({ id: 's1', number: 1, status: 'ended', recap: 'You met Old Tam.', dmNotes: 'Old notes.' }),
    ],
    sessionNumber: 3,
    quests: sampleQuests(),
    journal: sampleJournal(),
    clocks: sampleClocks(),
    homebrew: [homebrew('Tide Ward', 'active'), homebrew('Old Curse', 'retired'), homebrew('Shared Charm', 'active', null)],
    combat: null,
    librarySources: [{ id: 'lib-phb', name: 'My PHB notes' }],
    ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  it('is deterministic: identical state gives identical text, whatever the input order', () => {
    const a = buildSystemPrompt(input());
    const b = buildSystemPrompt(input());
    expect(b).toBe(a);
    const shuffled = input({
      journal: [...sampleJournal()].reverse(),
      quests: [...sampleQuests()].reverse(),
      clocks: [...sampleClocks()].reverse(),
      sessions: [...input().sessions].reverse(),
      homebrew: [...input().homebrew].reverse(),
    });
    expect(buildSystemPrompt(shuffled)).toBe(a);
  });

  it('starts with the stable DM instructions and contains no timestamps or ids', () => {
    const text = buildSystemPrompt(input());
    expect(text.startsWith(DM_INSTRUCTIONS)).toBe(true);
    expect(text).not.toMatch(/1700000000000|camp-1|char-1|j-\d|q-\d|clk-\d/);
  });

  it('covers the essentials of running the table', () => {
    for (const phrase of [
      'Never decide or narrate what the hero says, does, thinks or feels',
      'Second person, present tense',
      'Order of truth',
      'Never invent numbers',
      'uncertain and failure would matter',
      '5 very easy, 10 easy, 15 medium, 20 hard, 25 very hard, 30 nearly impossible',
      'request_player_roll',
      'fail',
      'Never fudge, never retcon',
      'Enemies fight to win',
      'Run situations, not plots',
      'update_clocks',
      'set_scene with new_scene: true',
      'consult_oracle',
      'Heroic Inspiration',
      'kind "ruling"',
      'secret: true',
      'create_homebrew',
      'Lines are hard limits',
      'fade to black',
      '[X-card]',
      '<ooc>',
      'choices',
    ]) {
      expect(DM_INSTRUCTIONS, phrase).toContain(phrase);
    }
  });

  it('renders the campaign: table rules, safety, chronicle, hero, quests, journal, clocks, homebrew, library, scene', () => {
    const text = buildSystemPrompt(input());
    expect(text).toContain('- Name: The Drowned Lantern');
    expect(text).toContain('This is session 3.');
    expect(text).toContain('Balanced — use the rules as written');
    expect(text).toContain('Moderate — you may create new spells');
    expect(text).toContain('Standard — about 120–180 words per response.');
    expect(text).toContain('Tap to roll');
    expect(text).toContain('Leveling: milestone');
    expect(text).toContain('I love puzzles');
    expect(text).toContain('Lines (never include, not even off-screen): Harm to children');
    expect(text).toContain('Veils (may happen, but only off-screen — fade to black): Torture');
    // The chronicle: every recap in order, plus the latest DM notes only.
    expect(text.indexOf('You met Old Tam.')).toBeLessThan(text.indexOf('You reached the breakwater.'));
    expect(text).toContain('Your private notes from session 2');
    expect(text).toContain('Halvard is below.');
    expect(text).not.toContain('Old notes.');
    expect(text).toContain('# Mira Voss');
    expect(text).toContain('- [active] Find Keeper Halvard');
    expect(text).toContain('  - [x] Question Old Tam');
    expect(text).toContain('Keeper Halvard (missing) [SECRET');
    expect(text).toContain('### Rulings (house rules');
    expect(text).toContain('Climbing wet stone');
    expect(text).toContain('- The tide turns: 1/4 (countdown).');
    expect(text).toContain('Something stirs below: 2/6 (threat, secret)');
    expect(text).toContain('- Tide Ward (boon): Tide Ward summary');
    expect(text).toContain("Shared Charm (boon) (shared from the player's library)");
    expect(text).not.toContain('Old Curse summary');
    expect(text).toContain('- My PHB notes (imported by the player');
    expect(text).toContain('- Location: Saltmarsh Docks');
    expect(text).toContain('- Tension: 5 of 9');
    expect(text).not.toContain('## Combat in progress');
  });

  it('describes each table-rule level and includes an active combat', () => {
    const base = sampleCampaign();
    const text = buildSystemPrompt(
      input({
        campaign: {
          ...base,
          settings: {
            ...base.settings,
            homebrewFreedom: 'none',
            narrationLength: 'brief',
            rulesFidelity: 'strict',
            difficulty: 'brutal',
            playerRollMode: 'physical',
            milestoneLeveling: false,
            showDmRolls: true,
          },
        },
        combat: sampleCombat(),
      }),
    );
    expect(text).toContain('never call create_homebrew');
    expect(text).toContain('about 60–100 words');
    expect(text).toContain('Strict — run the rules as written');
    expect(text).toContain('Brutal — the world does not scale');
    expect(text).toContain('Physical dice');
    expect(text).toContain('experience points');
    expect(text).toContain('shown to the player');
    expect(text).toContain('## Combat in progress');
    expect(text).toContain('Bandit 1');
  });

  it('handles a brand-new campaign without a character or history', () => {
    const text = buildSystemPrompt(
      input({ character: null, sessions: [], quests: [], journal: [], clocks: [], homebrew: [], sessionNumber: 1 }),
    );
    expect(text).toContain('Nothing yet — this is the first session.');
    expect(text).toContain('The player has not made a character yet.');
    expect(text).toContain('## Quests\nNone yet.');
    expect(text).toContain('Start two or three for the threats in play.');
  });
});
