/**
 * The offline demo DM (Settings → demo mode). It makes NO API calls: it stands in for the
 * Anthropic client and answers each request with a scripted assistant message, streamed in small
 * chunks. The real agent loop, tool handlers and UI paths all run unchanged, and the transcript
 * holds valid API-shaped messages, so turning demo mode off mid-campaign keeps working.
 *
 * The script is a small state machine: which reply comes next depends on the kind of turn
 * (opening, player turn, wrap-up), how many player turns came before, and which tool the demo
 * DM called last in this turn.
 */
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaToolUseBlockParam,
  MessageCreateParamsBase,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { GameStore } from '@/state/gameStore';
import type { RollLogEntry } from '@/types';
import type { DmClient, DmDeps } from './deps';
import { makeMessage, scriptedStream, textBlock, toolUseBlock } from './scripted';
import { appRequestKind, isTurnStart } from './transcript';

export const MOCK_MODEL = 'solo-dm-demo';
/** Delay between streamed chunks, so the streaming UI is visible. */
export const MOCK_DELAY_MS = 18;
const MOCK_CHUNK = 9;

const DEMO_NOTE =
  "_Demo mode: this is Solo DM's offline, scripted DM, so the story follows a short fixed path. Add an Anthropic API key in Settings to play with Claude._";

// ---------------------------------------------------------------------------
// Reading the request
// ---------------------------------------------------------------------------

interface MockContext {
  deps: DmDeps;
  store: GameStore;
  /** The kind of the current turn. */
  kind: 'opening' | 'wrap-up' | 'player';
  /** The player's words this turn (empty for app turns). */
  playerText: string;
  /** 1-based count of in-character player turns so far this session. */
  playerTurn: number;
  /** Tool calls in the demo DM's previous reply this turn (empty at the start of a turn). */
  previous: BetaToolUseBlockParam[];
  /** The first tool the demo DM called this turn (decides which script the turn follows). */
  firstTool: string | undefined;
  /** Text of the tool results the app returned for the previous reply (empty at the start of a turn). */
  results: string[];
  heroName: string;
}

function blocks(param: BetaMessageParam): BetaContentBlockParam[] {
  if (param.role === 'system' || typeof param.content === 'string') return [];
  return param.content;
}

/** The player's words: the turn's last text block (an earlier unanswered message may come before it). */
function playerWords(turnStart: BetaMessageParam): string {
  const texts = blocks(turnStart).filter((b): b is Extract<BetaContentBlockParam, { type: 'text' }> => b.type === 'text');
  return texts.length > 1 ? (texts.at(-1)?.text ?? '') : '';
}

function resultsOf(message: BetaMessageParam | undefined): string[] {
  if (!message || message.role !== 'user') return [];
  return blocks(message)
    .filter((b): b is Extract<BetaContentBlockParam, { type: 'tool_result' }> => b.type === 'tool_result')
    .map((b) => (typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n')));
}

function isInCharacter(text: string): boolean {
  return !text.startsWith('<ooc>') && !text.includes('[X-card]');
}

function readContext(deps: DmDeps, params: MessageCreateParamsBase): MockContext {
  const messages = params.messages;
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isTurnStart(messages[i])) {
      start = i;
      break;
    }
  }
  const turnStart = start >= 0 ? messages[start] : undefined;
  const appKind = turnStart ? appRequestKind(turnStart) : null;
  const kind = appKind === 'session_start' ? 'opening' : appKind === 'session_end' ? 'wrap-up' : 'player';
  const playerTurn = messages.filter((m) => isTurnStart(m) && !appRequestKind(m) && isInCharacter(playerWords(m))).length;

  const replies = messages.slice(start + 1).filter((m) => m.role === 'assistant');
  const toolsOf = (m: BetaMessageParam | undefined) =>
    m ? blocks(m).filter((b): b is BetaToolUseBlockParam => b.type === 'tool_use') : [];
  const previous = toolsOf(replies.at(-1));
  const firstTool = toolsOf(replies[0])[0]?.name;
  const store = deps.store();
  return {
    deps,
    store,
    kind,
    playerText: turnStart ? playerWords(turnStart) : '',
    playerTurn,
    previous,
    firstTool,
    results: previous.length ? resultsOf(messages.at(-1)) : [],
    heroName: store.character?.name ?? 'traveler',
  };
}

/** Whether the player's last roll succeeded, from the tool result (the log hides unrevealed DCs). */
function playerSucceeded(ctx: MockContext): boolean {
  return /→ (success|hit|CRITICAL HIT)/.test(ctx.results.at(-1) ?? '');
}

function lastTool(ctx: MockContext): BetaToolUseBlockParam | undefined {
  return ctx.previous.at(-1);
}

function inputField(block: BetaToolUseBlockParam | undefined, key: string): unknown {
  return block && typeof block.input === 'object' && block.input !== null ? (block.input as Record<string, unknown>)[key] : undefined;
}

function lastRoll(ctx: MockContext, actor: 'player' | 'dm', purposeIncludes?: string): RollLogEntry | undefined {
  for (let i = ctx.store.log.length - 1; i >= 0; i--) {
    const e = ctx.store.log[i];
    if (e.kind === 'roll' && e.actor === actor && (!purposeIncludes || e.purpose.includes(purposeIncludes))) return e;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

type Reply = { content: BetaContentBlock[]; tools: boolean };

function say(text: string, choices?: string[]): Reply {
  const block = choices?.length ? `${text}\n\n\`\`\`choices\n${choices.join('\n')}\n\`\`\`` : text;
  return { content: [textBlock(block)], tools: false };
}

function call(ctx: MockContext, text: string | null, ...uses: { name: string; input: Record<string, unknown> }[]): Reply {
  const content: BetaContentBlock[] = text ? [textBlock(text)] : [];
  for (const use of uses) content.push(toolUseBlock(`toolu_demo_${ctx.deps.newId().replace(/-/g, '')}`, use.name, use.input));
  return { content, tools: true };
}

const ENEMY = 'Cutpurse';

function opening(ctx: MockContext): Reply {
  const campaign = ctx.store.campaign;
  const sessionNumber = ctx.store.activeSession?.number ?? 1;
  if (sessionNumber > 1) {
    const previous = [...ctx.store.sessions].reverse().find((s) => s.status === 'ended' && s.recap);
    const recap = previous?.recap ? previous.recap.split(/(?<=[.!?])\s+/).slice(0, 3).join(' ') : 'Last time, the trail went cold in the rain.';
    return say(`${DEMO_NOTE}\n\n*Previously…* ${recap}\n\nThe road picks up where you left it, ${ctx.heroName}. Somewhere ahead, the green light is burning again.`, [
      'Press on toward the light',
      'Look over your gear first',
      'Ask around for news',
    ]);
  }
  if (!lastTool(ctx)) {
    return call(
      ctx,
      null,
      {
        name: 'set_scene',
        input: {
          location: 'The Crooked Lantern Inn',
          time_of_day: 'dusk',
          weather: 'a thin, cold drizzle',
          mood: 'expectant',
          new_scene: true,
        },
      },
      {
        name: 'update_journal',
        input: {
          entries: [
            { kind: 'npc', name: 'Wren Hollowell', summary: 'Soft-spoken innkeeper of the Crooked Lantern who hears every rumor in town.', status: 'friendly', tags: ['innkeeper', 'Wren'] },
            { kind: 'location', name: 'The Crooked Lantern Inn', summary: 'A leaning roadside inn whose old brass lantern has not been lit in years.', tags: ['inn'] },
          ],
        },
      },
    );
  }
  const premise = campaign?.premise.trim();
  const hook = premise ? ` You came because of what you'd heard: *${premise}*` : '';
  return say(
    `${DEMO_NOTE}\n\nRain needles the shutters of **The Crooked Lantern Inn** as you shoulder the door open, and the common room goes briefly quiet.${hook}\n\nBehind the bar, **Wren Hollowell** dries a mug that is already dry, watching you over its rim. "You're the one they wrote to," she says, low. "Sit — before someone else notices you."`,
    ['Sit at the bar and ask Wren what she knows', 'Scan the room for anyone watching', 'Order a drink and wait'],
  );
}

function skillFor(text: string): string {
  const t = text.toLowerCase();
  if (/\b(sneak|hide|quiet|slip)\b/.test(t)) return 'stealth';
  if (/\b(ask|talk|convince|persuade|charm)\b/.test(t)) return 'persuasion';
  if (/\b(lie|bluff|trick)\b/.test(t)) return 'deception';
  if (/\b(search|examine|inspect|study)\b/.test(t)) return 'investigation';
  return 'perception';
}

function skillCheck(ctx: MockContext): Reply {
  if (!lastTool(ctx)) {
    return call(ctx, 'Wren leans closer, and the noise of the room seems to press in around the two of you.', {
      name: 'request_player_roll',
      input: {
        roll_type: 'skill',
        skill: skillFor(ctx.playerText),
        dc: 13,
        reveal_dc: true,
        reason: 'Read the room — on a failure, someone learns more about you than you learn about them',
      },
    });
  }
  return playerSucceeded(ctx)
    ? say(
        'It clicks into place: a hooded figure by the hearth has stopped pretending to drink. Their reflection in the window is watching *you*, and one hand rests beneath the cloak.\n\n"The lantern lit itself three nights ago," Wren murmurs. "Since then, people have been asking about anyone who came asking about it."',
        ['Confront the hooded figure', 'Keep talking to Wren', 'Slip out the back'],
      )
    : say(
        "Wren's whisper is still hanging in the air when you realize the hooded figure by the hearth has gone — and so has the coin purse you set on the bar.\n\nA draft from the kitchen door. Footsteps in the yard.",
        ['Chase them through the kitchen', 'Ask Wren who that was', 'Let it go for now'],
      );
}

function combatStart(ctx: MockContext): Reply {
  const prev = lastTool(ctx);
  const combat = ctx.store.combat;
  const heroAc = ctx.store.character?.armorClass ?? 12;
  const advanceOrEnd = (): Reply => {
    const current = combat?.combatants[combat.turnIndex];
    if (combat?.active && current && !current.isPlayer) return call(ctx, null, { name: 'update_combat', input: { action: 'next_turn' } });
    return say('The cutpurse circles, breathing hard, knife low. Your move.', ['Attack the cutpurse', 'Try to disarm them', 'Shout for the watch']);
  };
  if (!prev) {
    return call(ctx, 'A chair scrapes. The hooded figure is suddenly beside you, a knife catching the firelight — a **cutpurse** with nothing left to lose.', {
      name: 'start_combat',
      input: {
        encounter_name: 'Knife in the common room',
        combatants: [{ name: ENEMY, side: 'enemy', ac: 12, hp_max: 9, initiative_bonus: 2, stat_block: 'Bandit' }],
      },
    });
  }
  switch (prev.name) {
    case 'start_combat':
      if (!ctx.store.combat?.active) return say('The figure thinks better of it and vanishes into the rain.', ['Follow them', 'Stay inside']);
      // Striking from hiding: the ambusher has Advantage.
      return call(ctx, null, {
        name: 'roll_dice',
        input: { expression: '1d20+3', purpose: `${ENEMY} attacks ${ctx.heroName}`, dc: heroAc, is_attack: true, advantage: 'advantage' },
      });
    case 'roll_dice': {
      if (String(inputField(prev, 'purpose') ?? '').includes('attacks')) {
        const hit = lastRoll(ctx, 'dm', 'attacks')?.roll.success ?? false;
        if (hit) return call(ctx, 'The knife darts in under your guard.', { name: 'roll_dice', input: { expression: '1d4+2', purpose: `${ENEMY} knife damage` } });
        return advanceOrEnd();
      }
      const damage = lastRoll(ctx, 'dm', 'damage')?.roll.total ?? 3;
      return call(ctx, null, {
        name: 'update_character',
        input: { hp: { amount: damage, kind: 'damage', damage_type: 'piercing' }, reason: `${ENEMY}'s knife` },
      });
    }
    case 'update_character':
      return advanceOrEnd();
    default:
      return say('The cutpurse circles, breathing hard, knife low. Your move.', ['Attack the cutpurse', 'Try to disarm them', 'Shout for the watch']);
  }
}

function combatResolve(ctx: MockContext): Reply {
  const prev = lastTool(ctx);
  const attack = ctx.store.character?.attacks[0];
  if (!prev) {
    if (attack) {
      return call(ctx, null, {
        name: 'request_player_roll',
        input: { roll_type: 'attack', attack_name: attack.name, dc: 12, reason: `Strike the ${ENEMY.toLowerCase()} before they strike again` },
      });
    }
    return call(ctx, null, { name: 'request_player_roll', input: { roll_type: 'ability', ability: 'str', dc: 12, reason: 'Shove the cutpurse off balance' } });
  }
  switch (prev.name) {
    case 'request_player_roll': {
      const roll = lastRoll(ctx, 'player');
      if (inputField(prev, 'roll_type') === 'attack' && playerSucceeded(ctx) && attack) {
        const critical = /CRITICAL HIT/.test(ctx.results.at(-1) ?? '');
        return call(ctx, null, { name: 'request_player_roll', input: { roll_type: 'damage', attack_name: attack.name, critical, reason: 'Damage to the cutpurse' } });
      }
      if (inputField(prev, 'roll_type') === 'damage') {
        return call(ctx, null, { name: 'update_combat', input: { action: 'damage', target: ENEMY, amount: roll?.roll.total ?? 1 } });
      }
      return call(ctx, null, { name: 'end_combat', input: { summary: 'The cutpurse fled into the rain.', xp_award: 25 } });
    }
    case 'update_combat':
      return call(ctx, null, { name: 'end_combat', input: { summary: 'The cutpurse broke and ran, bleeding.', xp_award: 25 } });
    case 'end_combat':
      return call(ctx, null, {
        name: 'update_quest',
        input: {
          title: 'Who hired the cutpurse?',
          status: 'active',
          summary: 'Someone paid a knife to keep you from asking about the lantern.',
          giver: 'Wren Hollowell',
          objectives: [{ text: 'Find out who hired the cutpurse' }, { text: 'Learn why the lantern relit' }],
        },
      });
    default:
      return say(
        'The kitchen door bangs in the wind. On the floor where the cutpurse stood lies a tin token stamped with a lantern — the mark of a guild that supposedly died out years ago.\n\nWren picks it up and goes pale.',
        ['Ask Wren about the token', 'Search the yard', 'Pocket the token and say nothing'],
      );
  }
}

function worldTurn(ctx: MockContext): Reply {
  const prev = lastTool(ctx);
  const homebrewAllowed = ctx.store.campaign?.settings.homebrewFreedom !== 'none';
  if (!prev) {
    return call(
      ctx,
      null,
      {
        name: 'update_clocks',
        input: {
          clocks: [
            { name: 'The Lantern Guild closes in', segments: 6, advance: 1, kind: 'threat', secret: true, consequence: 'Guild enforcers come for the hero and for Wren.' },
          ],
        },
      },
      { name: 'consult_oracle', input: { question: 'Is anyone watching the inn tonight?', likelihood: 'likely' } },
    );
  }
  if (prev.name === 'consult_oracle' && homebrewAllowed) {
    return call(ctx, null, {
      name: 'create_homebrew',
      input: {
        kind: 'boon',
        name: 'Lantern-Touched',
        summary: 'Minor boon (homebrew)',
        text: 'Once per Long Rest, when you make an ability check in dim light or darkness, you can shed bright green light in a 10-foot radius until the end of your next turn and roll the check with Advantage.',
        comparables: ['Light (cantrip)', 'Guidance (cantrip)'],
        power_tier: 'minor',
        balance_notes: 'Weaker than a feat: once per long rest, situational, and the light gives your position away.',
      },
    });
  }
  if (prev.name === 'create_homebrew') {
    return call(ctx, null, {
      name: 'update_character',
      input: {
        features_add: [
          {
            name: 'Lantern-Touched',
            description: 'Once per Long Rest, in dim light or darkness: glow green (10 ft.) and gain Advantage on one ability check.',
            source: 'boon',
            uses_max: 1,
            recharge: 'long',
          },
        ],
        heroic_inspiration: true,
        reason: 'A gift from the old lantern',
      },
    });
  }
  return say(
    'Later, as the fire burns low, the old lantern above the bar flickers — and for a heartbeat it burns a cold, impossible green. Warmth floods your fingertips, and you understand, without knowing how, that the light has chosen you.\n\nOutside, someone in the rain is very carefully not looking at the inn.',
    ['Go out and confront the watcher', 'Bar the doors and rest', 'Ask Wren about the lantern'],
  );
}

const FREEFORM = [
  'The night stretches on. Rain drums the roof, and somewhere far off a bell tolls the hour — one more than it should.',
  'Morning comes grey and slow. The town wakes around you: carts, gulls, a crier reading a notice about a reward for "lantern thieves".',
  "The road out of town forks at a shrine whose candles are all burning green. Fresh boot prints lead both ways.",
];

function freeform(ctx: MockContext): Reply {
  const prev = lastTool(ctx);
  const n = Math.max(0, ctx.playerTurn - 5);
  if (!prev && n % 2 === 1) {
    return call(ctx, null, { name: 'consult_oracle', input: { question: 'Does the trail stay warm?', likelihood: 'even' } });
  }
  return say(FREEFORM[n % FREEFORM.length], ['Follow the trail', 'Rest and recover', 'Ask the locals']);
}

function wrapUp(ctx: MockContext): Reply {
  if (!lastTool(ctx)) {
    return call(ctx, null, {
      name: 'update_journal',
      input: {
        entries: [
          {
            kind: 'faction',
            name: 'The Lantern Guild',
            summary: 'A lamplighters\' guild said to have died out years ago; its token turned up on a hired knife.',
            status: 'hostile',
            secret: true,
          },
        ],
      },
    });
  }
  return say(
    `## Recap\nYou reached the Crooked Lantern Inn chasing a rumor, and found Wren Hollowell waiting for you with news nobody else wanted to hear: the old lantern had lit itself. A hired cutpurse tried to silence you in the common room and fled, leaving behind a tin token stamped with a lantern. That night the lantern burned green for you alone, and something of its light stayed in your hands.\n\n## DM Notes\nThe Lantern Guild hired the cutpurse. They want the lantern dark again and anyone who asks about it gone. Their clock is ticking; next session, a watcher reports back and the guild sends someone more dangerous. Wren knows more than she has said.`,
  );
}

function ooc(): Reply {
  return say(
    "(Out of character) I'm Solo DM's offline demo DM, so I can only follow a short script and can't really answer questions. Add an Anthropic API key in Settings to play with Claude, who can answer rules questions and run a real story.",
  );
}

function xCard(): Reply {
  return say('The moment passes and the scene shifts. You find yourself back at the bar, the fire crackling, Wren pouring two cups of something warm.', [
    'Talk with Wren',
    'Rest for the night',
  ]);
}

function reply(ctx: MockContext): Reply {
  if (ctx.kind === 'opening') return opening(ctx);
  if (ctx.kind === 'wrap-up') return wrapUp(ctx);
  if (ctx.playerText.startsWith('<ooc>')) return ooc();
  if (ctx.playerText.includes('[X-card]')) return xCard();
  switch (ctx.playerTurn) {
    case 1:
      return skillCheck(ctx);
    case 2:
      return combatStart(ctx);
    case 3: {
      const fighting = ctx.firstTool ? ctx.firstTool === 'request_player_roll' : Boolean(ctx.store.combat?.active);
      return fighting ? combatResolve(ctx) : worldTurn(ctx);
    }
    case 4:
      return worldTurn(ctx);
    default:
      return freeform(ctx);
  }
}

/** The scripted assistant message for a request. */
export function mockReply(deps: DmDeps, params: MessageCreateParamsBase): BetaMessage {
  const ctx = readContext(deps, params);
  const r = reply(ctx);
  return makeMessage(r.content, r.tools ? 'tool_use' : 'end_turn', { model: MOCK_MODEL });
}

/** A stand-in for the Anthropic client that answers from the script. */
export function createMockClient(deps: DmDeps): DmClient {
  return {
    beta: {
      messages: {
        stream: (params, options) =>
          scriptedStream(mockReply(deps, params), {
            signal: options?.signal,
            delayMs: MOCK_DELAY_MS,
            chunkSize: MOCK_CHUNK,
            sleep: deps.sleep,
          }),
      },
    },
  };
}
