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
import type { HomebrewEntry, Quest, TransformationsMode } from '@/types';
import type { IllustrationMode } from './modes';
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
      // A trigger for one of the hero's Reactions pauses the enemy turn for the player's decision.
      'stop before you apply the result',
      'Opportunity Attack',
      'Shield',
      // Heroic Inspiration can actually be spent, and a rules reroll isn't a retcon.
      'heroic_inspiration: false and request_player_roll again with the same parameters',
      'is not a retcon',
      // Level-up choices can be recorded.
      'ability_scores for an Ability Score Improvement',
      // Attacks that aren't on the sheet.
      'a spell the hero knows (a spell attack), or another weapon together with `ability`',
      '<unanswered_turn>',
    ]) {
      expect(DM_INSTRUCTIONS, phrase).toContain(phrase);
    }
  });

  it('renders the campaign: table rules, safety, chronicle, hero, quests, journal, clocks, homebrew, library, scene', () => {
    const text = buildSystemPrompt(input());
    expect(text).toContain('- Name: The Drowned Lantern');
    expect(text).toContain('This is session 3.');
    expect(text).toContain('Balanced — use the rules as written');
    expect(text).toContain('Moderate — improvise new spells, magic items, monsters, boons and minor rules whenever the story calls for them');
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

/** The text of one `## ` section of a prompt (up to the next `## ` or `# ` heading). */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}`);
  if (start < 0) return '';
  const rest = text.slice(start + 1);
  const next = rest.slice(heading.length).search(/\n#{1,2} /);
  return next < 0 ? rest : rest.slice(0, heading.length + next);
}

function withModes(transformations: TransformationsMode | undefined, illustrations?: IllustrationMode): string {
  const base = sampleCampaign();
  return buildSystemPrompt(input({ campaign: { ...base, settings: { ...base.settings, transformations } }, illustrations }));
}

describe('homebrew on the fly', () => {
  it('encourages improvising homebrew within the campaign setting, balanced, announced and saved', () => {
    const homebrew = section(DM_INSTRUCTIONS, '## Homebrew');
    for (const phrase of [
      'Improvise homebrew whenever the story calls for it, within the homebrew-freedom table rule',
      'a fey bargain with teeth',
      "Don't wait for a gap in the rules",
      'named SRD comparables',
      'create_homebrew',
      'announce it to the player before it affects a roll',
      'If the player vetoes something, retire or rework it without argument.',
    ]) {
      expect(homebrew, phrase).toContain(phrase);
    }
  });
});

describe('transformations, driven by the campaign setting', () => {
  it('a missing setting means Offered: offered only, no quota, costs, stages, a way it could end', () => {
    const text = section(withModes(undefined), '## Transformations');
    expect(text.startsWith('## Transformations: Offered\n')).toBe(true);
    for (const phrase of [
      'temptations, bargains, rewards or curses-with-a-choice',
      'nothing changes unless the player chooses it in the fiction',
      'player_chose_it: true',
      'No quota: the fiction decides how often',
      "Never shoehorn one in where it doesn't fit or make it routine",
      'never withhold one the player actively pursues and earns',
      'real costs and drawbacks along with its powers',
      'balanced like homebrew against named SRD comparables',
      'unfold in stages',
      "Respect the player's attachment to the hero they built",
      'how_it_ends',
      'transform_character',
    ]) {
      expect(text, phrase).toContain(phrase);
    }
    expect(text).not.toContain('imposed');
    expect(withModes('offered')).toBe(withModes(undefined));
  });

  it('Consequences adds imposed transformations, telegraphed, with a path back', () => {
    const text = section(withModes('consequences'), '## Transformations');
    expect(text.startsWith('## Transformations: Consequences\n')).toBe(true);
    for (const phrase of [
      "the player's knowing choices can also transform the hero even if they'd rather not",
      'bitten by a vampire lord after ignoring the warnings',
      'origin "imposed"',
      'Telegraph the danger clearly before it lands',
      'always leave a story path to resist, reverse or cure it',
      'No quota',
    ]) {
      expect(text, phrase).toContain(phrase);
    }
  });

  it('Off keeps the hero as built, without the rest of the guidance', () => {
    const text = section(withModes('off'), '## Transformations');
    expect(text).toContain('## Transformations: Off\nThe hero stays as built and changes only through normal leveling.');
    expect(text).toContain('Never begin or advance a transformation');
    expect(text).not.toContain('No quota');
  });
});

describe('illustrations, driven by the setting and the OpenAI key', () => {
  it('renders the guidance for each mode', () => {
    const off = section(withModes('offered', 'off'), '## Illustrations');
    expect(off).toContain('## Illustrations: Off\n');
    expect(off).toContain('Never call show_image.');
    const unavailable = section(withModes('offered'), '## Illustrations');
    expect(unavailable).toContain('## Illustrations: Not set up\n');
    expect(unavailable).toContain('Never call show_image or bring up pictures');
    expect(unavailable).toContain('add an OpenAI API key in Settings → Illustrations');
    const request = section(withModes('offered', 'request'), '## Illustrations');
    expect(request).toContain('## Illustrations: On request\nCall show_image only when the player asks to see something');
    expect(request).toContain('never on your own initiative');
    expect(request).toContain("keep narrating, and don't describe the picture or wait for it");
    const moments = section(withModes('offered', 'moments'), '## Illustrations');
    for (const phrase of ['a key moment', 'arriving somewhere new, a big reveal, a fight about to start', 'at most about once per scene', 'Never for routine beats']) {
      expect(moments, phrase).toContain(phrase);
    }
  });

  it('lets an out-of-character request for a picture use show_image', () => {
    expect(section(DM_INSTRUCTIONS, '## Table talk')).toContain('If they ask to see something, use show_image as the illustrations rule allows.');
  });
});

describe('ambitions and an indifferent world', () => {
  it('takes the player anywhere, but makes ambitions earned, tracked on clocks, and fallible', () => {
    const text = section(DM_INSTRUCTIONS, '## Ambitions and an indifferent world');
    for (const phrase of [
      'The player may take the story anywhere',
      'adapt your prepared material to their direction instead of steering them back to it',
      "You needn't indulge every whim",
      'a declaration is not progress',
      'When the player commits to one, record it with update_quest (ambition: true)',
      'no objectives of your own',
      'Add objectives only for concrete steps the hero has identified themselves',
      'never turn an ambition into a checklist of steps you invented',
      'progress clock (update_clocks, kind "progress")',
      '6 segments for a local goal, up to 12',
      'Advance it only for concrete accomplishments earned in the fiction',
      'allies won, resources secured, rivals outplayed, risks survived, rolls made',
      'roll it back for setbacks',
      'threat clock for the opposition',
      'egregious ones can close the door for good',
      'The world is indifferent — not adversarial, not accommodating',
      'NPCs and factions pursue their own interests',
    ]) {
      expect(text, phrase).toContain(phrase);
    }
  });

  it('lists ambitions in their own group of the quest log', () => {
    const ambition: Quest = {
      id: 'q-amb',
      campaignId: 'camp-1',
      title: 'Found a thieves\' guild',
      status: 'active',
      summary: 'Mira wants the docks to answer to her.',
      objectives: [{ id: 'o-a', text: 'Win over the dockside urchins', done: false }],
      ambition: true,
      createdAt: 2,
      updatedAt: 2,
    };
    const text = buildSystemPrompt(input({ quests: [...sampleQuests(), ambition] }));
    const quests = section(text, '## Quests');
    expect(quests.indexOf('- [active] Find Keeper Halvard')).toBeLessThan(quests.indexOf('### Ambitions'));
    expect(quests).toContain("### Ambitions (the hero's own goals: no checklists; progress only for what they earn, on their clocks)\n- [active] Found a thieves' guild");
    const onlyAmbition = section(buildSystemPrompt(input({ quests: [ambition] })), '## Quests');
    expect(onlyAmbition).toContain('## Quests\nNone besides the ambitions below.');
  });
});

describe('the new sections stay deterministic', () => {
  it('renders identical text for identical settings, and different text when a mode changes', () => {
    expect(withModes('consequences', 'moments')).toBe(withModes('consequences', 'moments'));
    expect(withModes('consequences', 'moments')).not.toBe(withModes('consequences', 'request'));
    const text = withModes('off', 'request');
    const campaignPart = text.indexOf('# This campaign');
    const order = ['## Table rules', '## Transformations: Off', '## Illustrations: On request', '## Safety'].map((h) => text.indexOf(h, campaignPart));
    expect(order.every((at, i) => at > campaignPart && (i === 0 || at > order[i - 1]))).toBe(true);
    expect(DM_INSTRUCTIONS).not.toMatch(/## (Transformations|Illustrations):/);
  });
});
