/**
 * Initiative tracker and NPC hit points. Pure functions over CombatState.
 *
 * Event messages are player-facing: for combatants with hideHp they describe health
 * ("bloodied") instead of exact numbers. summarizeCombat(state) gives the DM the exact figures.
 */
import type { Combatant, CombatState, GameEvent, HitPoints } from '@/types';
import { nameKey } from '@/lib/id';
import { conditionName } from './conditions';
import { gameEvent, matchByName, toInt, warning } from './util';

function compareCombatants(a: Combatant, b: Combatant): number {
  return (
    b.initiative - a.initiative ||
    b.initiativeBonus - a.initiativeBonus ||
    Number(b.isPlayer) - Number(a.isPlayer) ||
    a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' })
  );
}

/** Highest initiative first; ties broken by initiativeBonus, then the player first, then name. */
export function sortCombatants(list: Combatant[]): Combatant[] {
  return [...list].sort(compareCombatants);
}

/** "Goblin 2" -> { base: "Goblin", n: 2 }. */
function splitNumber(name: string): { base: string; n: number | null } {
  const match = /^(.*?)\s+(\d+)$/.exec(name.trim());
  return match ? { base: match[1], n: Number(match[2]) } : { base: name.trim(), n: null };
}

/** A name that doesn't collide (case-insensitively) with `taken`: "Goblin" -> "Goblin 2" if "Goblin" exists. */
function uniqueName(name: string, taken: readonly string[]): string {
  const keys = new Set(taken.map((t) => t.trim().toLowerCase()));
  if (!keys.has(name.trim().toLowerCase())) return name.trim();
  const { base } = splitNumber(name);
  const used = taken
    .map(splitNumber)
    .filter((s) => s.base.toLowerCase() === base.toLowerCase())
    .map((s) => s.n ?? 1);
  let n = Math.max(1, ...used) + 1;
  while (keys.has(`${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
}

/** Number duplicate names in one batch: three "Goblin" become "Goblin 1", "Goblin 2", "Goblin 3". */
function numberDuplicates(list: readonly Combatant[]): Combatant[] {
  const counts = new Map<string, number>();
  for (const c of list) counts.set(c.name.trim().toLowerCase(), (counts.get(c.name.trim().toLowerCase()) ?? 0) + 1);
  const seen = new Map<string, number>();
  const named: Combatant[] = [];
  for (const c of list) {
    const key = c.name.trim().toLowerCase();
    if ((counts.get(key) ?? 0) < 2) {
      named.push(c);
      continue;
    }
    let n = (seen.get(key) ?? 0) + 1;
    let candidate = `${c.name.trim()} ${n}`;
    const taken = [...list.map((x) => x.name), ...named.map((x) => x.name)];
    while (taken.some((t) => t.trim().toLowerCase() === candidate.toLowerCase())) candidate = `${c.name.trim()} ${++n}`;
    seen.set(key, n);
    named.push({ ...c, name: candidate });
  }
  return named;
}

function firstActiveIndex(combatants: readonly Combatant[]): number {
  const index = combatants.findIndex((c) => !c.defeated);
  return index < 0 ? 0 : index;
}

/** Start a combat at round 1. Duplicate names are numbered ("Goblin 1", "Goblin 2"). */
export function createCombat(combatants: Combatant[], encounterName?: string): CombatState {
  const sorted = sortCombatants(numberDuplicates(combatants));
  const state: CombatState = { active: true, round: 1, turnIndex: firstActiveIndex(sorted), combatants: sorted, startedAt: Date.now() };
  return encounterName?.trim() ? { ...state, encounterName: encounterName.trim() } : state;
}

export function currentCombatant(state: CombatState): Combatant | null {
  if (state.combatants.length === 0) return null;
  return state.combatants[Math.min(Math.max(0, state.turnIndex), state.combatants.length - 1)] ?? null;
}

/** First non-defeated combatant at or after `start` (wrapping, which starts a new round). */
function advanceFrom(state: CombatState, start: number): CombatState {
  const n = state.combatants.length;
  if (n === 0) return { ...state, turnIndex: 0 };
  for (let step = 0; step < n; step++) {
    const raw = start + step;
    const index = raw % n;
    if (!state.combatants[index].defeated) return { ...state, turnIndex: index, round: state.round + (raw >= n ? 1 : 0) };
  }
  return { ...state, turnIndex: Math.min(Math.max(0, state.turnIndex), n - 1) };
}

/** Advance to the next non-defeated combatant; increments the round when wrapping. */
export function nextTurn(state: CombatState): CombatState {
  if (state.combatants.length === 0 || state.combatants.every((c) => c.defeated)) return state;
  return advanceFrom(state, state.turnIndex + 1);
}

/** Insert by initiative; the current turn keeps pointing at the same creature. Duplicate names get a number. */
export function addCombatant(state: CombatState, combatant: Combatant): CombatState {
  const named = { ...combatant, name: uniqueName(combatant.name, state.combatants.map((c) => c.name)) };
  const at = state.combatants.findIndex((c) => compareCombatants(named, c) < 0);
  const index = at < 0 ? state.combatants.length : at;
  const combatants = [...state.combatants.slice(0, index), named, ...state.combatants.slice(index)];
  if (state.combatants.length === 0) return { ...state, combatants, turnIndex: 0 };
  return { ...state, combatants, turnIndex: index <= state.turnIndex ? state.turnIndex + 1 : state.turnIndex };
}

/** Remove a combatant. Removing the creature whose turn it is passes the turn to the next one. */
export function removeCombatant(state: CombatState, id: string): CombatState {
  const index = state.combatants.findIndex((c) => c.id === id);
  if (index < 0) return state;
  const combatants = state.combatants.filter((c) => c.id !== id);
  if (index < state.turnIndex) return { ...state, combatants, turnIndex: state.turnIndex - 1 };
  if (index > state.turnIndex) return { ...state, combatants };
  if (combatants.length === 0) return { ...state, combatants, turnIndex: 0 };
  // The current creature left: whoever was next acts now.
  return advanceFrom({ ...state, combatants }, index);
}

/** Patch a combatant (its id never changes). Initiative changes re-sort it; the current turn stays put. */
export function updateCombatant(state: CombatState, id: string, patch: Partial<Combatant>): CombatState {
  const index = state.combatants.findIndex((c) => c.id === id);
  if (index < 0) return state;
  const old = state.combatants[index];
  const updated: Combatant = { ...old, ...patch, id: old.id };
  if (patch.hp && patch.defeated === undefined && !updated.isPlayer) updated.defeated = updated.hp !== undefined && updated.hp.current <= 0;
  const resort = patch.initiative !== undefined || patch.initiativeBonus !== undefined || patch.name !== undefined;
  if (!resort) return { ...state, combatants: state.combatants.map((c, i) => (i === index ? updated : c)) };
  const currentId = currentCombatant(state)?.id;
  const combatants = sortCombatants(state.combatants.map((c, i) => (i === index ? updated : c)));
  const turnIndex = Math.max(0, combatants.findIndex((c) => c.id === currentId));
  return { ...state, combatants, turnIndex };
}

/** Find by id, or by case-insensitive name ("goblin 2"); a unique partial name ("bandit c") also works. */
export function findCombatant(state: CombatState, idOrName: string): Combatant | undefined {
  const query = idOrName.trim();
  if (!query) return undefined;
  const byId = state.combatants.find((c) => c.id === query);
  if (byId) return byId;
  const key = nameKey(query);
  return state.combatants.find((c) => nameKey(c.name) === key) ?? matchByName(state.combatants, query, (c) => c.name).match;
}

/** Player-safe health description for hidden HP: "unhurt" | "scratched" | "bloodied" (≤ half) | "critical" (≤ 1/4) | "down". */
export function healthDescriptor(hp: HitPoints): 'unhurt' | 'scratched' | 'bloodied' | 'critical' | 'down' {
  if (hp.current <= 0) return 'down';
  if (hp.current >= hp.max) return 'unhurt';
  if (hp.current * 4 <= hp.max) return 'critical';
  if (hp.current * 2 <= hp.max) return 'bloodied';
  return 'scratched';
}

function hpText(c: Combatant, hp: HitPoints, forPlayer: boolean): string {
  if (forPlayer && c.hideHp) return healthDescriptor(hp);
  return `HP ${hp.current}/${hp.max}${hp.temp > 0 ? ` (+${hp.temp} temp)` : ''}`;
}

function npcTarget(state: CombatState, id: string): Combatant | string {
  const target = state.combatants.find((c) => c.id === id) ?? findCombatant(state, id);
  if (!target) return `No combatant "${id}".`;
  if (target.isPlayer) return `${target.name}'s HP live on the character sheet — apply damage or healing to the character instead.`;
  if (!target.hp) return `${target.name} has no tracked HP.`;
  return target;
}

/** Damage a non-player combatant: temp HP first; defeated at 0 HP. */
export function damageCombatant(state: CombatState, id: string, amount: number): { state: CombatState; events: GameEvent[] } {
  const target = npcTarget(state, id);
  if (typeof target === 'string') return { state, events: [warning(target)] };
  const damage = Math.max(0, toInt(amount));
  if (damage === 0) return { state, events: [] };
  const hp = target.hp as HitPoints;
  const absorbed = Math.min(Math.max(0, hp.temp), damage);
  const next: HitPoints = { ...hp, temp: hp.temp - absorbed, current: Math.max(0, hp.current - (damage - absorbed)) };
  const defeated = next.current <= 0;
  const updated: Combatant = { ...target, hp: next, defeated: target.defeated || defeated };
  const combatants = state.combatants.map((c) => (c.id === target.id ? updated : c));
  const status = defeated ? ' — defeated' : '';
  const message = target.hideHp
    ? `${target.name} takes ${damage} damage (${healthDescriptor(next)})${status}`
    : `${target.name} takes ${damage} damage (HP ${hp.current} → ${next.current}${absorbed ? `, ${absorbed} absorbed by temporary HP` : ''})${status}`;
  return { state: { ...state, combatants }, events: [gameEvent('combat', message)] };
}

export function healCombatant(state: CombatState, id: string, amount: number): { state: CombatState; events: GameEvent[] } {
  const target = npcTarget(state, id);
  if (typeof target === 'string') return { state, events: [warning(target)] };
  const heal = Math.max(0, toInt(amount));
  if (heal === 0) return { state, events: [] };
  const hp = target.hp as HitPoints;
  const next: HitPoints = { ...hp, current: Math.min(hp.max, hp.current + heal) };
  const revived = target.defeated && next.current > 0;
  const updated: Combatant = { ...target, hp: next, defeated: next.current > 0 ? false : target.defeated };
  const combatants = state.combatants.map((c) => (c.id === target.id ? updated : c));
  const back = revived ? ' — back in the fight' : '';
  const message = target.hideHp
    ? `${target.name} regains ${next.current - hp.current} HP (${healthDescriptor(next)})${back}`
    : `${target.name} regains ${next.current - hp.current} HP (HP ${hp.current} → ${next.current})${back}`;
  return { state: { ...state, combatants }, events: [gameEvent('combat', message)] };
}

function sideLabel(c: Combatant, forPlayer: boolean): string {
  if (c.isPlayer || c.side === 'player') return forPlayer ? 'you' : 'PC';
  return c.side;
}

function conditionText(c: Combatant): string {
  return c.conditions.map((x) => `${conditionName(x.id)}${x.level ? ` ${x.level}` : ''}`).join(', ');
}

function combatantLine(c: Combatant, position: number, current: boolean, forPlayer: boolean): string {
  const bits = [`Init ${c.initiative}`];
  // A creature whose HP the DM hides keeps its AC hidden from the player too.
  if (c.ac !== undefined && !(forPlayer && c.hideHp && !c.isPlayer)) bits.push(`AC ${c.ac}`);
  if (c.hp) bits.push(hpText(c, c.hp, forPlayer));
  const conditions = conditionText(c);
  if (conditions) bits.push(conditions);
  if (c.defeated) bits.push('defeated');
  // The stat block behind a name is DM knowledge (a "Hooded Stranger" may be a Vampire Spawn).
  const showKind = !forPlayer && c.statBlockName && nameKey(c.statBlockName) !== nameKey(c.name.replace(/\s+\d+$/, ''));
  const kind = showKind ? ` [${c.statBlockName}]` : '';
  const notes = c.notes?.trim() && !forPlayer ? ` — ${c.notes.trim()}` : '';
  return `${current ? '→' : ' '} ${position}. ${c.name} (${sideLabel(c, forPlayer)})${kind} · ${bits.join(' · ')}${notes}`;
}

/**
 * Text summary of the tracker: round, turn order with initiative, HP, AC, conditions.
 * forPlayer = true is safe to show the player: no stat block names or DM notes, and for hideHp
 * combatants a health descriptor instead of exact HP and no AC.
 */
export function summarizeCombat(state: CombatState, opts: { forPlayer?: boolean } = {}): string {
  if (!state.active) return `Combat ended${state.encounterName ? `: ${state.encounterName}` : ''}.`;
  const forPlayer = !!opts.forPlayer;
  const current = currentCombatant(state);
  const header = `Combat${state.encounterName ? `: ${state.encounterName}` : ''} — round ${state.round}${current ? `, ${current.name}'s turn` : ''}`;
  const lines = state.combatants.map((c, i) => combatantLine(c, i + 1, i === state.turnIndex, forPlayer));
  return [header, ...lines].join('\n');
}
