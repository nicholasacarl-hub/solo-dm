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
  sampleMappedCombat,
  sampleQuests,
  sampleSession,
} from '@/test/fixtures';
import type { BattleMapsMode, MapEffect } from '@/types';
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

  it("leaves a magic item's conditions and uncounted bonuses to the DM's judgment, applied through the numbers it passes", () => {
    const rolls = section(DM_INSTRUCTIONS, '## Rolls and rulings');
    const items = rolls.split('\n').find((line) => line.startsWith('- Magic items:')) ?? '';
    for (const phrase of [
      'the app counts only the item bonuses that the AC formula and the Saving throws line name',
      'an attack or damage bonus (the item\'s tag says "not counted by the app")',
      "one from an SRD or homebrew item's text",
      'one its text gives only in some situations',
      "a counted one whose condition doesn't hold",
      'Adjust the number you pass by it',
      'without giving away a hidden DC or AC',
      'add a damage bonus to the damage you apply',
      'tell the player in a line',
      'get_entry',
    ]) {
      expect(items, phrase).toContain(phrase);
    }
    // The order of truth and table talk leave a number the app worked out to the text it came from.
    expect(DM_INSTRUCTIONS).toContain("When sources disagree, the earlier one wins, except that a rule's, feature's or item's own text, or a ruling you recorded, beats a number the app worked out from it (see Magic items).");
    expect(section(DM_INSTRUCTIONS, '## Table talk')).toContain('A number the app worked out is different: if they point to a condition it missed');
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

  it('explains reviewed entries, older-format notes and left-out book text only when the player has imports (spec §6.5)', () => {
    const reviewed = '- Entries marked "reviewed" in lookups carry numbers the player checked; start_combat uses them when you leave AC, HP and initiative out. "Adapted for 2024" lines say how the app fitted older-format content: keep the sheet as the app set it unless the player agrees to a change.';
    const leftOut = `- Text marked "[Text from the player's imported book … was left out of this copy.]" can be read again: get_character_sheet for the hero's features, get_entry for rules.`;
    const withImports = buildSystemPrompt(input());
    expect(withImports).toContain(`- My PHB notes (imported by the player — look its content up before relying on it)\n${reviewed}\n${leftOut}`);
    const srdOnly = buildSystemPrompt(input({ librarySources: [{ id: 'srd-5.2.1', name: 'SRD 5.2.1' }, { id: 'homebrew', name: 'Homebrew' }] }));
    expect(srdOnly).not.toContain('reviewed');
    expect(srdOnly).not.toContain('was left out of this copy');
    expect(srdOnly).toContain('## Rules library (lookup_rules and get_entry search all of it)\n- SRD 5.2.1 (always available)\n\n');
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

  it("freezes the hero's AC from the sheet into \"Combat in progress\", not the tracker's copy from the start of the fight", () => {
    // The fight's copy of the hero says AC 12; a shield donned mid-fight made the sheet's 14.
    const fight = section(buildSystemPrompt(input({ character: sampleCharacter({ armorClass: 14 }), combat: sampleCombat() })), '## Combat in progress');
    expect(fight.split('\n').find((line) => line.includes('Mira Voss ·'))).toBe('  17 Mira Voss · AC 14');
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

describe('journal lines', () => {
  it('points to search_memory for the rest of details the line cuts, and only then', () => {
    const [tam, ...rest] = sampleJournal();
    const long = { ...tam, details: `${'He mends nets by the harbor every morning and watches the lantern. '.repeat(6)}The end.` };
    const prompt = buildSystemPrompt(input({ journal: [long, ...rest] }));
    expect(prompt).toContain(`… (search_memory "Old Tam" has all of it)`);
    expect(buildSystemPrompt(input())).not.toContain('has all of it');
  });
});

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

function withBattleMaps(battleMaps: BattleMapsMode | undefined): string {
  const base = sampleCampaign();
  return buildSystemPrompt(input({ campaign: { ...base, settings: { ...base.settings, battleMaps } } }));
}

describe('the battle map in the prompt (spec §5.1–§5.3)', () => {
  it('names the battle map among the books the app keeps, and the map steps of combat flow and Reactions', () => {
    expect(DM_INSTRUCTIONS).toContain('The character sheet, dice, initiative, the battle map, quests, journal, clocks and scene live in the app');
    expect(DM_INSTRUCTIONS).toContain(
      "on a battle map move it first (move_tokens), then roll attacks and damage, apply them, then update_combat next_turn; creatures that share an initiative roll still take separate turns — until it is the hero's turn",
    );
    expect(DM_INSTRUCTIONS).toContain("Calls that don't depend on each other can go in the same response (damage, then next_turn).");
    expect(DM_INSTRUCTIONS).toContain(
      "a foe leaving their reach (an Opportunity Attack — on a battle map, move_tokens asks the player itself and gives you the answer, so don't ask again)",
    );
    expect(DM_INSTRUCTIONS).not.toMatch(/## Battle maps/);
  });

  it("renders the campaign's battle-maps rule after the illustrations section (missing = When it helps)", () => {
    const text = withBattleMaps(undefined);
    const campaignPart = text.indexOf('# This campaign');
    const at = (h: string) => text.indexOf(h, campaignPart);
    expect(at('## Illustrations:')).toBeLessThan(at('## Battle maps: When it helps'));
    expect(at('## Battle maps: When it helps')).toBeLessThan(at('## Safety'));
    expect(withBattleMaps('auto')).toBe(text);
    expect(section(withBattleMaps('off'), '## Battle maps')).toContain('## Battle maps: Off\n');
    expect(section(withBattleMaps('always'), '## Battle maps')).toContain('## Battle maps: Every fight\n');
  });

  it('freezes the map layout into "Combat in progress" for a session that starts mid-fight, without ids', () => {
    const combat = sampleMappedCombat();
    const web: MapEffect = {
      id: 'e20',
      label: 'Web',
      spec: { shape: 'squares', rects: [{ x0: 6, y0: 6, x1: 9, y1: 9 }] },
      rects: [{ x0: 6, y0: 6, x1: 9, y1: 9 }],
      terrain: ['difficult', 'obscured'],
      duration: 'lasting',
      round: 2,
      turnOfId: 'c-1',
    };
    const text = buildSystemPrompt(input({ combat: { ...combat, map: { ...(combat.map as NonNullable<typeof combat.map>), effects: [web] } } }));
    const fight = section(text, '## Combat in progress');
    expect(fight).toContain('Battle map at the start of this session (<game_state> has the current positions): Dockside warehouse, 16×12 squares (A1 top-left)');
    expect(fight).toContain(
      'Terrain: wall (office wall) L5:P5 · door (office door, closed) N5 · wall (pillar) I4 · half cover (crates) E5:F6 · difficult (spilled grain) H8:J9 · deep water (flooded dock) N10:P12 · hazard (brazier) G11',
    );
    expect(fight).toContain('Places: the loading door A5:B7 · the office L1:P4');
    expect(fight).toContain('Effects: Web G7:J10 (difficult, obscured)');
    expect(fight).not.toMatch(/\bc-\d|map-\d|\b[tpe]\d+\b/);
    expect(buildSystemPrompt(input({ combat: sampleCombat() }))).not.toContain('Battle map at the start');
  });
});
