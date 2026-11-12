/**
 * World tools: the journal (the DM's long-term memory), quests, progress clocks, the scene and
 * tension dial, the oracle, and searching earlier sessions.
 */
import { consultOracle, sceneCheck } from '@/engine';
import type { ClockUpsert, JournalUpsert, QuestUpsert } from '@/state/gameStore';
import type { Clock, JournalEntry, Quest, QuestObjective, Scene } from '@/types';
import { nameKey } from '@/lib/id';
import { closeCutWrapper } from '@/lib/importedContent';
import { safeEnd } from '@/lib/text';
import { truncate } from '../narration';
import type { ToolInput } from './definitions';
import {
  clamp,
  defined,
  logTool,
  ok,
  plural,
  requireCampaign,
  type ToolContext,
  type ToolOutcome,
} from './context';

export const JOURNAL_KIND_LABELS: Record<JournalEntry['kind'], string> = {
  npc: 'NPC',
  location: 'Location',
  faction: 'Faction',
  item: 'Item',
  lore: 'Lore',
  event: 'Event',
  ruling: 'Ruling',
  note: 'Note',
};

// ---------------------------------------------------------------------------
// update_journal
// ---------------------------------------------------------------------------

function mergeTags(previous: readonly string[] | undefined, next: readonly string[] | undefined): string[] | undefined {
  if (!next) return previous ? [...previous] : undefined;
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const tag of [...(previous ?? []), ...next]) {
    const clean = tag.trim();
    if (clean && !seen.has(clean.toLowerCase())) {
      seen.add(clean.toLowerCase());
      merged.push(clean);
    }
  }
  return merged;
}

export async function updateJournalTool(input: ToolInput<'update_journal'>, ctx: ToolContext): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  requireCampaign(store);
  const findExisting = (kind: string, name: string) =>
    store.journal.find((j) => j.kind === kind && nameKey(j.name) === nameKey(name));

  const upserts: JournalUpsert[] = input.entries.map((e) => {
    const prev = findExisting(e.kind, e.name);
    return {
      kind: e.kind,
      // Matching is case-insensitive; an update keeps the entry's established name.
      name: prev?.name ?? e.name.trim(),
      summary: e.summary,
      secret: e.secret ?? prev?.secret ?? false,
      tags: mergeTags(prev?.tags, e.tags) ?? [],
      ...defined({ details: e.details, status: e.status }),
    };
  });
  const existed = input.entries.map((e) => Boolean(findExisting(e.kind, e.name)));
  const saved = await store.upsertJournal(upserts);

  const lines: string[] = [];
  for (const [i, entry] of saved.entries()) {
    const verb = existed[i] ? 'updated' : 'added';
    const label = `${entry.name} (${JOURNAL_KIND_LABELS[entry.kind]})`;
    await logTool(ctx, 'update_journal', 'journal', `Journal: ${label} ${verb}`, {
      detail: entry.summary,
      secret: entry.secret,
      refId: entry.id,
    });
    lines.push(`${label} ${verb}${entry.secret ? ' [secret]' : ''}.`);
  }
  return ok(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// update_quest
// ---------------------------------------------------------------------------

function mergeObjectives(
  ctx: ToolContext,
  previous: readonly QuestObjective[],
  updates: ToolInput<'update_quest'>['objectives'],
): { objectives: QuestObjective[]; added: string[]; completed: string[] } {
  const objectives = previous.map((o) => ({ ...o }));
  const added: string[] = [];
  const completed: string[] = [];
  for (const u of updates ?? []) {
    const existing = objectives.find((o) => nameKey(o.text) === nameKey(u.text));
    if (existing) {
      if (u.done !== undefined && u.done !== existing.done) {
        existing.done = u.done;
        if (u.done) completed.push(existing.text);
      }
    } else {
      objectives.push({ id: ctx.deps.newId(), text: u.text.trim(), done: u.done ?? false });
      added.push(u.text.trim());
      if (u.done) completed.push(u.text.trim());
    }
  }
  return { objectives, added, completed };
}

function questSummary(prev: Quest | undefined, saved: Quest, added: string[], completed: string[]): string {
  if (!prev) {
    if (saved.status === 'rumor') return `Rumor: ${saved.title}`;
    return saved.ambition ? `New ambition: ${saved.title}` : `New quest: ${saved.title}`;
  }
  const parts: string[] = [];
  if (Boolean(prev.ambition) !== Boolean(saved.ambition)) parts.push(saved.ambition ? 'now an ambition' : 'no longer an ambition');
  if (prev.status !== saved.status) parts.push(saved.status);
  if (completed.length) parts.push(`done: ${completed.join('; ')}`);
  if (added.length) parts.push(`new objective${added.length > 1 ? 's' : ''}: ${added.join('; ')}`);
  return `${saved.ambition ? 'Ambition' : 'Quest'}: ${saved.title}${parts.length ? ` — ${parts.join(' · ')}` : ' updated'}`;
}

const AMBITION_CLOCKS =
  'Track it with a progress clock (update_clocks, kind "progress", 6–12 segments by its scale) that advances only for accomplishments the hero earns in the fiction and goes back for setbacks — usually paired with a threat clock for the opposition it stirs up. A declaration alone is not progress.';
const AMBITION_OBJECTIVES =
  "Ambition objectives are only for concrete steps the hero has identified themselves — never a checklist of your own.";

/** Reminders that keep an ambition earned rather than checked off. */
function ambitionNotes(prev: Quest | undefined, saved: Quest, added: string[]): string[] {
  if (!saved.ambition) return [];
  const notes: string[] = [];
  if (!prev?.ambition) notes.push(AMBITION_CLOCKS);
  if (added.length) notes.push(AMBITION_OBJECTIVES);
  return notes;
}

export async function updateQuestTool(input: ToolInput<'update_quest'>, ctx: ToolContext): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  requireCampaign(store);
  const prev = store.quests.find((q) => nameKey(q.title) === nameKey(input.title));
  const merged = mergeObjectives(ctx, prev?.objectives ?? [], input.objectives);
  const upsert: QuestUpsert = {
    title: prev?.title ?? input.title.trim(),
    status: input.status ?? prev?.status ?? 'active',
    summary: input.summary ?? prev?.summary ?? '',
    objectives: merged.objectives,
    ...defined({ giver: input.giver, reward: input.reward, secretNotes: input.secret_notes, ambition: input.ambition }),
  };
  const saved = await store.upsertQuest(upsert);
  const summary = questSummary(prev, saved, merged.added, merged.completed);
  await logTool(ctx, 'update_quest', 'quest', summary, { detail: saved.summary || undefined, refId: saved.id });

  const open = saved.objectives.filter((o) => !o.done).map((o) => o.text);
  const lines = [`${summary}. Status: ${saved.status}. Open objectives: ${open.length ? open.join('; ') : 'none'}.`];
  lines.push(...ambitionNotes(prev, saved, merged.added));
  return ok(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// update_clocks
// ---------------------------------------------------------------------------

const DEFAULT_SEGMENTS = 4;

function isFull(c: Pick<Clock, 'filled' | 'segments'>): boolean {
  return c.filled >= c.segments;
}

export async function updateClocksTool(input: ToolInput<'update_clocks'>, ctx: ToolContext): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  requireCampaign(store);
  const lines: string[] = [];
  for (const spec of input.clocks) {
    const prev = ctx.deps.store().clocks.find((c) => nameKey(c.name) === nameKey(spec.name));
    const segments = spec.segments ?? prev?.segments ?? DEFAULT_SEGMENTS;
    const filled = clamp(spec.set_filled ?? (prev?.filled ?? 0) + (spec.advance ?? 0), 0, segments);
    const upsert: ClockUpsert = {
      name: prev?.name ?? spec.name.trim(),
      segments,
      filled,
      kind: spec.kind ?? prev?.kind ?? 'threat',
      secret: spec.secret ?? prev?.secret ?? false,
      ...defined({ consequence: spec.consequence, resolved: spec.resolved }),
    };
    const saved = await ctx.deps.store().upsertClock(upsert);
    const justFilled = isFull(saved) && !(prev && isFull(prev)) && !saved.resolved;
    const state = saved.resolved ? 'resolved' : justFilled ? 'FILLED' : `${saved.filled}/${saved.segments}`;
    await logTool(ctx, 'update_clocks', 'quest', `Clock: ${saved.name} ${saved.filled}/${saved.segments}${saved.resolved ? ' (resolved)' : justFilled ? ' — filled!' : ''}`, {
      secret: saved.secret,
      refId: saved.id,
      ...(saved.consequence && !saved.secret ? { detail: `When it fills: ${saved.consequence}` } : {}),
    });
    let line = `${saved.name}: ${state}${prev ? '' : ` (new ${saved.kind} clock, ${plural(saved.segments, 'segment')})`}`;
    if (!prev && spec.segments === undefined) line += ' — no size given, so it has 4 segments';
    if (justFilled) {
      line += `. Consequence: ${saved.consequence ?? '(none recorded)'} — make it happen in the fiction now or very soon, then mark the clock resolved.`;
    }
    lines.push(line);
  }
  return ok(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// set_scene
// ---------------------------------------------------------------------------

export function formatScene(scene: Scene): string {
  return [
    scene.location || 'Unknown location',
    scene.region,
    scene.timeOfDay,
    scene.inWorldDate,
    scene.weather,
    scene.mood ? `mood: ${scene.mood}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

function nextScene(current: Scene, input: ToolInput<'set_scene'>): Scene {
  return {
    ...current,
    ...defined({
      location: input.location,
      region: input.region,
      timeOfDay: input.time_of_day,
      inWorldDate: input.in_world_date,
      weather: input.weather,
      mood: input.mood,
    }),
  };
}

const SCENE_FIELDS = ['location', 'region', 'time_of_day', 'in_world_date', 'weather', 'mood'] as const;

export async function setSceneTool(input: ToolInput<'set_scene'>, ctx: ToolContext): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  const campaign = requireCampaign(store);
  const scene = nextScene(campaign.scene, input);
  const tension = clamp(campaign.tension + (input.tension_change ?? 0), 1, 9);
  const check = input.new_scene ? sceneCheck(tension, ctx.deps.rng) : undefined;
  await store.updateCampaign({ scene, tension });

  const sceneChanged = SCENE_FIELDS.some((f) => input[f] !== undefined);
  if (sceneChanged || input.new_scene) {
    await logTool(ctx, 'set_scene', 'scene', `${input.new_scene ? 'New scene' : 'Scene'}: ${formatScene(scene)}`);
  }
  const lines = [`Scene: ${formatScene(scene)}.`];
  if (tension !== campaign.tension) lines.push(`Tension ${campaign.tension} → ${tension} (of 9).`);
  else lines.push(`Tension: ${tension} (of 9).`);
  if (check) {
    const verdict =
      check.outcome === 'expected'
        ? 'expected — the scene begins as you planned it'
        : check.outcome === 'altered'
          ? 'ALTERED — the scene is not quite what was expected; change one important detail'
          : 'INTERRUPTED — something else happens instead; build a different scene';
    const twist = check.twist ? ` Twist: ${check.twist}.` : '';
    lines.push(`Scene check: d10 = ${check.roll} vs tension ${check.tension} → ${verdict}.${twist}`);
    await logTool(ctx, 'set_scene', 'scene', `Scene check: ${check.outcome}`, {
      detail: `d10 ${check.roll} vs tension ${check.tension}${check.twist ? ` · ${check.twist}` : ''}`,
      secret: true,
    });
  }
  return ok(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// consult_oracle
// ---------------------------------------------------------------------------

export async function consultOracleTool(input: ToolInput<'consult_oracle'>, ctx: ToolContext): Promise<ToolOutcome> {
  const result = consultOracle(input.question, input.likelihood, ctx.deps.rng);
  const target = result.target;
  await logTool(ctx, 'consult_oracle', 'oracle', `Oracle: ${truncate(input.question, 80)} — ${result.label}`, {
    detail: `d100 ${result.roll} vs ${target} (${input.likelihood})${result.twist ? ` · Twist: ${result.twist}` : ''}`,
    secret: input.secret ?? false,
  });
  const twist = result.twist ? ` Twist (doubles): ${result.twist}.` : '';
  return ok(
    `Oracle (${input.likelihood}, ${target}%): d100 = ${result.roll} → ${result.label}.${twist} Interpret it in the fiction and honor it.`,
  );
}

// ---------------------------------------------------------------------------
// search_memory
// ---------------------------------------------------------------------------

interface MemoryDoc {
  title: string;
  label: string;
  text: string;
  secret: boolean;
}

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'what', 'who', 'where', 'when', 'was', 'are', 'did']);

function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}']+/u))].filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function memoryDocs(ctx: ToolContext): MemoryDoc[] {
  const s = ctx.deps.store();
  const docs: MemoryDoc[] = [];
  for (const j of s.journal) {
    docs.push({
      title: j.name,
      label: `${JOURNAL_KIND_LABELS[j.kind]}${j.status ? `, ${j.status}` : ''}`,
      text: [j.summary, j.details, j.tags.length ? `Tags: ${j.tags.join(', ')}` : ''].filter(Boolean).join('\n'),
      secret: j.secret,
    });
  }
  for (const q of s.quests) {
    const objectives = q.objectives.map((o) => `${o.done ? '[x]' : '[ ]'} ${o.text}`).join('; ');
    docs.push({
      title: q.title,
      label: `${q.ambition ? 'Ambition' : 'Quest'}, ${q.status}`,
      text: [q.summary, q.giver && `Giver: ${q.giver}`, q.reward && `Reward: ${q.reward}`, objectives, q.secretNotes && `DM notes: ${q.secretNotes}`]
        .filter(Boolean)
        .join('\n'),
      secret: false,
    });
  }
  for (const c of s.clocks) {
    docs.push({ title: c.name, label: `Clock ${c.filled}/${c.segments}${c.resolved ? ', resolved' : ''}`, text: c.consequence ?? '', secret: c.secret });
  }
  for (const session of s.sessions) {
    if (session.recap) docs.push({ title: `Session ${session.number} recap`, label: 'Recap', text: session.recap, secret: false });
    if (session.dmNotes) docs.push({ title: `Session ${session.number} DM notes`, label: 'Your notes', text: session.dmNotes, secret: true });
  }
  return docs;
}

function score(doc: MemoryDoc, words: string[], phrase: string): number {
  const title = doc.title.toLowerCase();
  const body = doc.text.toLowerCase();
  let total = 0;
  for (const w of words) {
    if (title.includes(w)) total += 3;
    total += Math.min(3, body.split(w).length - 1);
  }
  if (phrase.length > 3 && (title.includes(phrase) || body.includes(phrase))) total += 4;
  return total;
}

function snippet(text: string, words: string[]): string {
  const lower = text.toLowerCase();
  const hits = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0);
  const at = hits.length ? Math.min(...hits) : 0;
  // Both ends at whole characters (never half an emoji), and a cut inside a wrapped passage closed again.
  const start = safeEnd(text, Math.max(0, at - 120));
  const end = safeEnd(text, start + 420);
  const piece = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return closeCutWrapper(`${start > 0 ? '…' : ''}${piece}${end < text.length ? '…' : ''}`);
}

export async function searchMemoryTool(input: ToolInput<'search_memory'>, ctx: ToolContext): Promise<ToolOutcome> {
  const words = terms(input.query);
  const phrase = input.query.trim().toLowerCase();
  const docs = memoryDocs(ctx);
  // An entry the query names exactly (case and spacing aside: "Ix", "李白" too) comes first and whole: the prompt's
  // journal lines point here for details they cut.
  const plain = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
  const named = (title: string) => plain(title) === plain(input.query);
  if (words.length === 0 && !docs.some((d) => named(d.title))) return ok('Give a more specific query (names, places, keywords).');
  const ranked = docs
    .map((doc) => ({ doc, score: score(doc, words, phrase) + (named(doc.title) ? 1000 : 0) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title))
    .slice(0, input.limit ?? 6);
  await logTool(ctx, 'search_memory', 'journal', `Searched memory: ${truncate(input.query, 60)}`, { secret: true });
  if (ranked.length === 0) {
    return ok(`Nothing in the journal, quests, clocks or session recaps matches "${input.query}". It may be new — or try other words.`);
  }
  return ok(
    ranked
      .map(({ doc }) => `- ${doc.title} (${doc.label}${doc.secret ? ', secret' : ''}): ${named(doc.title) ? doc.text.trim().replace(/\n/g, '\n  ') : snippet(doc.text, words)}`)
      .join('\n'),
  );
}
