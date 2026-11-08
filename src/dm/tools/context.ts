/**
 * What a tool handler receives, plus helpers shared by the handlers: precondition checks,
 * atomic character updates, and log lines.
 */
import type { DmPhase, GameStore } from '@/state/gameStore';
import type {
  Campaign,
  Character,
  CombatState,
  D20TestResult,
  GameEvent,
  NewLogEntry,
  PlayerRollType,
  ToolActivityIcon,
} from '@/types';
import type { DmDeps } from '../deps';

export interface ToolContext {
  deps: DmDeps;
  /** Aborted when the player cancels; handlers waiting on the player must stop. */
  signal: AbortSignal;
  /** Update the status bar while the tool runs. */
  status(activity: string, phase?: Extract<DmPhase, 'tool' | 'waiting-player'>): void;
}

/** What goes back to Claude as the tool_result. */
export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

/** A problem with the tool call itself (bad target, missing field, rule violation): returned as is_error. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export function ok(content: string): ToolOutcome {
  return { content };
}

export function fail(content: string): ToolOutcome {
  return { content, isError: true };
}

export function requireCampaign(store: GameStore): Campaign {
  if (!store.campaign) throw new ToolInputError('No campaign is loaded.');
  return store.campaign;
}

export function requireCharacter(store: GameStore): Character {
  if (!store.character) {
    throw new ToolInputError('The hero has no character sheet yet. Ask the player to finish their character in the builder.');
  }
  return store.character;
}

/** Result shape of the engine's pure character functions. */
export interface CharacterChange {
  character: Character;
}

/**
 * Apply a pure engine change atomically through the store and return the engine's full result.
 * `fn` runs against the store's latest character.
 */
export async function mutateCharacter<T extends CharacterChange>(
  ctx: ToolContext,
  fn: (c: Character) => T,
): Promise<T> {
  const store = ctx.deps.store();
  requireCharacter(store);
  let result: T | undefined;
  await store.updateCharacter((c) => {
    result = fn(c);
    return result.character;
  });
  if (!result) throw new Error('The character update did not run.');
  return result;
}

/** Precondition texts about the game state (returned with fail(), spec §4.2). */
export const NO_COMBAT = 'No combat is active. Use start_combat first.';
export const NO_MAP = 'This fight has no battle map: describe positions in words, or add one with update_map create.';
export const MAPS_OFF = "Battle maps are Off in this campaign's table rules: keep this fight in the theater of the mind.";

/**
 * Apply a pure engine change to the store's latest combat (store.updateCombat) and return the engine's full result.
 * Every combat handler does its awaiting first (rules index, rolls, the player's answers), then writes once through
 * this against the latest state, so nothing written meanwhile (a move the player committed) is lost. When `fn`
 * returns the same state, nothing is written. Throwing inside `fn` aborts the write.
 */
export async function mutateCombat<T extends { state: CombatState }>(ctx: ToolContext, fn: (c: CombatState) => T): Promise<T> {
  const store = ctx.deps.store();
  if (!store.combat) throw new ToolInputError(NO_COMBAT);
  let result: T | undefined;
  await store.updateCombat((c) => {
    result = fn(c);
    return result.state;
  });
  if (!result) throw new Error('The combat update did not run.');
  return result;
}

export async function logEntry(ctx: ToolContext, entry: NewLogEntry): Promise<void> {
  await ctx.deps.store().appendLog(entry);
}

export async function logTool(
  ctx: ToolContext,
  tool: string,
  icon: ToolActivityIcon,
  summary: string,
  extra: { detail?: string; secret?: boolean; refId?: string } = {},
): Promise<void> {
  const entry: NewLogEntry = { kind: 'tool', tool, icon, summary };
  if (extra.detail) entry.detail = extra.detail;
  if (extra.secret) entry.secret = true;
  if (extra.refId) entry.refId = extra.refId;
  await logEntry(ctx, entry);
}

export async function logRoll(
  ctx: ToolContext,
  roll: {
    actor: 'player' | 'dm';
    purpose: string;
    result: D20TestResult;
    secret?: boolean;
    manual?: boolean;
    rollType?: PlayerRollType;
  },
): Promise<void> {
  const entry: NewLogEntry = {
    kind: 'roll',
    actor: roll.actor,
    purpose: roll.purpose,
    roll: roll.result,
    secret: roll.secret ?? false,
  };
  if (roll.manual) entry.manual = true;
  if (roll.rollType) entry.rollType = roll.rollType;
  await logEntry(ctx, entry);
}

export function eventLines(events: readonly GameEvent[]): string[] {
  return events.map((e) => (e.type === 'warning' ? `Warning: ${e.message}` : e.message));
}

export function warningsOf(events: readonly GameEvent[]): GameEvent[] {
  return events.filter((e) => e.type === 'warning');
}

export function changesOf(events: readonly GameEvent[]): GameEvent[] {
  return events.filter((e) => e.type !== 'warning');
}

/** Copy of an object without its undefined values (so upserts never blank existing fields). */
export function defined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
