/**
 * Rules tools: searching and reading the compendium (SRD 5.2.1 + the player's imports + homebrew),
 * and creating or revising homebrew within the campaign's homebrew-freedom setting.
 *
 * Text from an imported book is wrapped with wrapImported(), so exported saves and cloud sync can
 * leave it out of the copy (it stays in the live session).
 */
import type { RulesIndex, SearchHit } from '@/data';
import { nameKey } from '@/lib/id';
import { wrapImported } from '@/lib/importedContent';
import {
  HOMEBREW_SOURCE_ID,
  SRD_SOURCE_ID,
  type Campaign,
  type CompendiumEntry,
  type ContentKind,
  type HomebrewEntry,
} from '@/types';
import { truncate } from '../narration';
import type { ToolInput } from './definitions';
import { defined, fail, logTool, ok, requireCampaign, ToolInputError, type ToolContext, type ToolOutcome } from './context';

/** Looking these up can spoil a surprise ("Mimic"), so their log lines stay behind the DM screen. */
const SPOILER_KINDS: ReadonlySet<ContentKind> = new Set<ContentKind>(['monster', 'magic-item', 'item', 'boon', 'other']);

function isSpoiler(entries: readonly CompendiumEntry[], kinds?: readonly string[]): boolean {
  return entries.some((e) => SPOILER_KINDS.has(e.kind) || e.sourceId === HOMEBREW_SOURCE_ID) || (kinds ?? []).some((k) => SPOILER_KINDS.has(k as ContentKind));
}

/** Total characters of rules text returned per call, and per entry. */
export const RULES_OUTPUT_LIMIT = 6000;
export const RULES_HIT_LIMIT = 1800;

/**
 * Sources the DM may consult: the SRD, every import switched on in the player's Library (the rules
 * index holds exactly those), any import this campaign enabled, and homebrew (the index shows only
 * shared homebrew and this campaign's).
 */
export function allowedSources(campaign: Campaign, index?: Pick<RulesIndex, 'sources'>): string[] {
  const indexed = index ? index.sources().map((s) => s.id) : [];
  return [...new Set([SRD_SOURCE_ID, ...campaign.settings.enabledSources, ...indexed, HOMEBREW_SOURCE_ID])];
}

/** Content from the player's imported books (not the SRD, not homebrew). */
function isImported(entry: CompendiumEntry): boolean {
  return entry.sourceId !== SRD_SOURCE_ID && entry.sourceId !== HOMEBREW_SOURCE_ID;
}

/** Imported text is marked so saves and sync can leave it out (see src/lib/importedContent.ts). */
function shielded(entry: CompendiumEntry, text: string): string {
  return isImported(entry) ? wrapImported(entry.sourceName, text) : text;
}

/** 0 = this campaign's homebrew, 1 = shared homebrew, 2 = imports, 3 = SRD (as the index ranks them). */
function sourceRank(entry: CompendiumEntry): number {
  if (entry.sourceId === HOMEBREW_SOURCE_ID) return (entry as Partial<HomebrewEntry>).campaignId ? 0 : 1;
  return entry.sourceId === SRD_SOURCE_ID ? 3 : 2;
}

/**
 * One entry by name from the sources the DM may consult. The index's name lookup ranks every
 * source it holds, so when its pick is off-limits here, the best allowed entry with that name wins
 * instead (an SRD spell is never hidden behind an import of the same name).
 */
export function findAllowedEntry(
  index: RulesIndex,
  name: string,
  opts: { kind?: ContentKind; campaign: Campaign },
): CompendiumEntry | undefined {
  const { campaign } = opts;
  const sources = allowedSources(campaign, index);
  const visible = (e: CompendiumEntry) => {
    const owner = (e as Partial<HomebrewEntry>).campaignId ?? null;
    return e.sourceId !== HOMEBREW_SOURCE_ID || owner === null || owner === campaign.id;
  };
  const found = index.findByName(name, { kind: opts.kind, campaignId: campaign.id });
  if (!found || (sources.includes(found.sourceId) && visible(found))) return found;
  const keys = new Set([nameKey(name), nameKey(found.name)]);
  const candidates = sources
    .flatMap((sourceId) => index.list({ kind: opts.kind, sourceId }))
    .filter((e) => keys.has(nameKey(e.name)) && visible(e));
  candidates.sort((a, b) => sourceRank(a) - sourceRank(b) || Number(b.kind === found.kind) - Number(a.kind === found.kind));
  return candidates[0];
}

async function loadIndex(ctx: ToolContext): Promise<RulesIndex> {
  try {
    return await ctx.deps.rulesIndex();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ToolInputError(
      `The rules compendium isn't available right now (${reason}). Rule from your own knowledge of the 2024 rules for now, and tell the player it's a provisional ruling.`,
    );
  }
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const para = cut.lastIndexOf('\n');
  return `${(para > max * 0.7 ? cut.slice(0, para) : cut).trimEnd()}\n…(truncated — use get_entry for the full text)`;
}

function entryHeading(entry: CompendiumEntry): string {
  const status = (entry as Partial<HomebrewEntry>).status === 'retired' ? ', retired — do not use' : '';
  const path = entry.path?.length ? ` — ${entry.path.join(' › ')}` : '';
  return `${entry.name} (${entry.kind} · ${entry.sourceName}${status})${path}`;
}

function formatHits(hits: readonly SearchHit[]): string {
  const parts: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const e = hit.entry;
    const block = [`## ${entryHeading(e)}`, e.summary ?? '', clip(e.text, RULES_HIT_LIMIT)].filter(Boolean).join('\n');
    if (used + block.length > RULES_OUTPUT_LIMIT) {
      const room = RULES_OUTPUT_LIMIT - used;
      if (room > 400) parts.push(shielded(e, clip(block, room)));
      parts.push(`(…${hits.length - parts.length} more result(s) omitted — narrow the query or use get_entry)`);
      break;
    }
    parts.push(shielded(e, block));
    used += block.length;
  }
  return parts.join('\n\n');
}

export async function lookupRulesTool(input: ToolInput<'lookup_rules'>, ctx: ToolContext): Promise<ToolOutcome> {
  const campaign = requireCampaign(ctx.deps.store());
  const index = await loadIndex(ctx);
  const hits = index.search(input.query, {
    kinds: input.kinds as ContentKind[] | undefined,
    sourceIds: allowedSources(campaign, index),
    campaignId: campaign.id,
    limit: input.limit ?? 5,
  });
  await logTool(ctx, 'lookup_rules', 'rules', `Rules: ${truncate(input.query, 70)}`, {
    detail: hits.length ? hits.map((h) => `${h.entry.name} (${h.entry.sourceName})`).join('\n') : 'No results',
    secret: isSpoiler(hits.map((h) => h.entry), input.kinds),
  });
  if (hits.length === 0) {
    return ok(`No rules matched "${input.query}". Try different keywords, or rule fairly from the 2024 rules and record it as a ruling.`);
  }
  return ok(formatHits(hits));
}

export async function getEntryTool(input: ToolInput<'get_entry'>, ctx: ToolContext): Promise<ToolOutcome> {
  const campaign = requireCampaign(ctx.deps.store());
  const index = await loadIndex(ctx);
  const kind = input.kind as ContentKind | undefined;
  const found = findAllowedEntry(index, input.name, { kind, campaign });
  if (!found) {
    const sources = allowedSources(campaign, index);
    const near = index.search(input.name, { kinds: kind ? [kind] : undefined, sourceIds: sources, campaignId: campaign.id, limit: 5 });
    const names = near.map((h) => `${h.entry.name} (${h.entry.kind})`).join(', ');
    return ok(`No entry named "${input.name}"${kind ? ` (${kind})` : ''}.${names ? ` Closest matches: ${names}.` : ''}`);
  }
  await logTool(ctx, 'get_entry', 'rules', `Looked up: ${found.name}`, { secret: isSpoiler([found]) });
  const body = [`# ${entryHeading(found)}`, found.summary ?? '', clip(found.text, RULES_OUTPUT_LIMIT)].filter(Boolean);
  const hb = found as Partial<HomebrewEntry>;
  if (hb.balanceNotes) body.push(`Balance notes: ${hb.balanceNotes}`);
  return ok(shielded(found, body.join('\n\n')));
}

// ---------------------------------------------------------------------------
// Homebrew
// ---------------------------------------------------------------------------

function refuseIfDisabled(campaign: Campaign): void {
  if (campaign.settings.homebrewFreedom === 'none') {
    throw new ToolInputError(
      'Homebrew is turned off in this campaign: use only official rules content. (The player can change this in the campaign settings.)',
    );
  }
}

function balanceText(notes: string, comparables: readonly string[], tier: string | undefined): string {
  return [notes.trim(), `Compared with: ${comparables.join(', ')}.`, tier ? `Power tier: ${tier}.` : ''].filter(Boolean).join('\n');
}

/** The DM's own words from composed balance notes (without the generated comparison lines). */
function ownNotes(notes: string | undefined): string {
  return (notes ?? '')
    .split('\n')
    .filter((line) => !/^(Compared with|Power tier):/.test(line))
    .join('\n')
    .trim();
}

async function basedOnRef(ctx: ToolContext, name: string | undefined, campaign: Campaign): Promise<HomebrewEntry['basedOn']> {
  if (!name) return undefined;
  try {
    const index = await ctx.deps.rulesIndex();
    const id = findAllowedEntry(index, name, { campaign })?.id;
    return id ? { name, id } : { name };
  } catch {
    return { name };
  }
}

function campaignHomebrew(ctx: ToolContext, campaign: Campaign, name: string): HomebrewEntry | undefined {
  return ctx.deps.store().homebrew.find((h) => h.campaignId === campaign.id && nameKey(h.name) === nameKey(name));
}

export async function createHomebrewTool(input: ToolInput<'create_homebrew'>, ctx: ToolContext): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  const campaign = requireCampaign(store);
  refuseIfDisabled(campaign);
  const existing = campaignHomebrew(ctx, campaign, input.name);
  if (existing && existing.status === 'active') {
    return fail(`Homebrew named "${existing.name}" already exists in this campaign. Use update_homebrew to change it, or pick another name.`);
  }
  const now = ctx.deps.now();
  const entry: HomebrewEntry = {
    id: `hb:${ctx.deps.newId()}`,
    sourceId: HOMEBREW_SOURCE_ID,
    sourceName: 'Homebrew',
    kind: input.kind as ContentKind,
    name: input.name.trim(),
    summary: input.summary,
    text: input.text,
    data: defined({ comparables: input.comparables, powerTier: input.power_tier }),
    campaignId: campaign.id,
    origin: 'dm',
    balanceNotes: balanceText(input.balance_notes, input.comparables, input.power_tier),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...defined({ basedOn: await basedOnRef(ctx, input.based_on, campaign) }),
  };
  await store.saveHomebrew(entry);
  ctx.deps.invalidateRulesIndex();
  await logTool(ctx, 'create_homebrew', 'homebrew', `Homebrew: ${entry.name} (${entry.kind})`, {
    detail: [entry.summary, entry.text, `**Balance:** ${entry.balanceNotes}`].join('\n\n'),
    refId: entry.id,
  });
  return ok(
    `Saved homebrew "${entry.name}" to the campaign compendium. The player can read it and may veto it — announce it before it affects a roll.`,
  );
}

export async function updateHomebrewTool(input: ToolInput<'update_homebrew'>, ctx: ToolContext): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  const campaign = requireCampaign(store);
  refuseIfDisabled(campaign);
  const entry = campaignHomebrew(ctx, campaign, input.name);
  if (!entry) {
    const shared = store.homebrew.find((h) => h.campaignId === null && nameKey(h.name) === nameKey(input.name));
    if (shared) return fail(`"${shared.name}" is shared homebrew from the player's library; only the player can edit it there.`);
    const names = store.homebrew.filter((h) => h.campaignId === campaign.id).map((h) => h.name).join(', ') || 'none';
    return fail(`No homebrew named "${input.name}" in this campaign (campaign homebrew: ${names}).`);
  }
  const prevData = entry.data ?? {};
  const comparables = input.comparables ?? (Array.isArray(prevData.comparables) ? (prevData.comparables as string[]) : []);
  const tier = input.power_tier ?? (typeof prevData.powerTier === 'string' ? prevData.powerTier : undefined);
  const notesChanged = input.balance_notes !== undefined || input.comparables !== undefined || input.power_tier !== undefined;
  const updated: HomebrewEntry = {
    ...entry,
    ...defined({ name: input.new_name?.trim(), summary: input.summary, text: input.text, status: input.status }),
    data: { ...prevData, ...defined({ comparables: input.comparables, powerTier: input.power_tier }) },
    ...(notesChanged ? { balanceNotes: balanceText(input.balance_notes ?? ownNotes(entry.balanceNotes), comparables, tier) } : {}),
    updatedAt: ctx.deps.now(),
  };
  await store.saveHomebrew(updated);
  ctx.deps.invalidateRulesIndex();
  const verb = updated.status === 'retired' && entry.status !== 'retired' ? 'retired' : 'updated';
  await logTool(ctx, 'update_homebrew', 'homebrew', `Homebrew ${verb}: ${updated.name} — ${truncate(input.reason, 80)}`, {
    detail: [updated.summary, updated.text].join('\n\n'),
    refId: updated.id,
  });
  return ok(`Homebrew "${updated.name}" ${verb}.`);
}
