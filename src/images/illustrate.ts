/**
 * Illustrations in the story log: a pending image entry appears at once, the picture is painted in
 * the background (at most two at a time), saved to the gallery, and the entry turns ready or failed.
 * If the player has left the table meanwhile, the entry is updated in storage so it shows next time.
 */
import type { AppSettings, ImageLogEntry, ImageSubject, NewLogEntry } from '@/types';
import { newId } from '@/lib/id';
import { useGame } from '@/state/gameStore';
import { getSettings } from '@/state/settingsStore';
import { IMAGE_CAMPAIGN_MISSING, markImageLogEntry, saveImage, type ImageLogPatch } from '@/storage';
import { IMAGE_DECLINED } from './errors';
import { explainPaintError, IMAGE_SIZES, paint, type ImageAspect } from './openai';
import { buildImagePrompt, campaignArtStyle, describeHero, heroInFrame, SUBJECT_FRAMING } from './prompt';
import { TaskQueue } from './queue';

export interface IllustrationRequest {
  campaignId: string;
  title: string;
  subject: ImageSubject;
  /** A vivid, specific visual description written by the DM (no text, captions, maps or UI). */
  prompt: string;
  aspect?: ImageAspect;
  /**
   * Whether the hero is in the picture (their look from the sheet is added). Default: yes for
   * 'character' (the hero's portrait) and 'battle', otherwise when the title or prompt names them.
   */
  heroInFrame?: boolean;
}

export type IllustrationStart = { ok: true; imageId: string; logEntryId: string } | { ok: false; reason: string };

/** At most this many pictures are painted at once; the rest wait their turn. */
export const MAX_PARALLEL_PAINTINGS = 2;

/** Shared by illustrations and portraits, so the player's key never has more than two requests open. */
export const paintingQueue = new TaskQueue(MAX_PARALLEL_PAINTINGS);

export const NOT_AT_TABLE = 'Pictures can only be painted for the campaign at the table.';

const DEFAULT_ASPECT: Record<ImageSubject, ImageAspect> = {
  scene: 'landscape',
  battle: 'landscape',
  creature: 'landscape',
  character: 'portrait',
  npc: 'portrait',
  item: 'square',
};

const DEFAULT_TITLE: Record<ImageSubject, string> = {
  scene: 'A new place',
  battle: 'The battle',
  creature: 'A creature',
  character: 'Your hero',
  npc: 'A face in the story',
  item: 'A curious object',
};

const MAX_TITLE = 80;

/** Whether illustrations can be made right now (a key is set and the frequency isn't "off"). */
export function imagesAvailable(settings: AppSettings = getSettings()): { ok: true } | { ok: false; reason: string } {
  const images = settings.images;
  if (images.frequency === 'off') return { ok: false, reason: 'Illustrations are turned off (Settings → Illustrations).' };
  if (!images.openaiApiKey.trim()) {
    return { ok: false, reason: 'Pictures need an OpenAI API key: the player can add one in Settings → Illustrations.' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Pictures being painted in this tab (for the story log's cards)
// ---------------------------------------------------------------------------

const painting = new Set<string>();
const listeners = new Set<() => void>();

function setPainting(imageId: string, on: boolean): void {
  if (on === painting.has(imageId)) return;
  if (on) painting.add(imageId);
  else painting.delete(imageId);
  for (const listener of [...listeners]) listener();
}

/** True while this tab is painting (or waiting to paint) the picture. */
export function isPainting(imageId: string): boolean {
  return painting.has(imageId);
}

export function subscribePainting(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Background painting
// ---------------------------------------------------------------------------

interface Job {
  imageId: string;
  logEntryId: string;
  campaignId: string;
  sessionId: string | null;
  title: string;
  subject: ImageSubject;
  /** The full prompt sent to the model. */
  prompt: string;
  aspect: ImageAspect;
}

/** Failed jobs this tab can paint again (a retry reuses the entry and the prompt). */
const retryable = new Map<string, Job>();

/** Mark the log entry: through the game store when its campaign is at the table, else in storage. */
async function settle(job: Job, change: ImageLogPatch): Promise<void> {
  // Only a failed picture keeps an error (a retried one loses the old reason).
  const patch: ImageLogPatch = change.status === 'failed' ? change : { ...change, error: undefined };
  const game = useGame.getState();
  const atTable = game.campaign?.id === job.campaignId && game.log.some((e) => e.id === job.logEntryId);
  if (atTable) {
    try {
      await game.updateLog(job.logEntryId, patch);
      return;
    } catch {
      // Refused (open in another tab, or replaced meanwhile): write it to storage directly below.
    }
  }
  try {
    await markImageLogEntry(job.logEntryId, patch);
  } catch (error) {
    console.warn('[images] Could not update the picture in the story log:', error);
  }
}

async function paintInBackground(job: Job, settings: AppSettings['images']): Promise<void> {
  setPainting(job.imageId, true);
  try {
    const picture = await paintingQueue.run(() =>
      paint({ apiKey: settings.openaiApiKey, settings, prompt: job.prompt, aspect: job.aspect }),
    );
    await saveImage({
      id: job.imageId,
      campaignId: job.campaignId,
      sessionId: job.sessionId,
      title: job.title,
      subject: job.subject,
      prompt: job.prompt,
      model: settings.model,
      mime: picture.mime,
      blob: picture.blob,
      createdAt: Date.now(),
    });
    retryable.delete(job.imageId);
    await settle(job, { status: 'ready' });
  } catch (error) {
    // The campaign was deleted meanwhile: there is no card left to mark.
    if (error instanceof Error && error.message === IMAGE_CAMPAIGN_MISSING) return;
    const reason = await explainPaintError(error, settings.model);
    if (reason !== IMAGE_DECLINED) retryable.set(job.imageId, job);
    await settle(job, { status: 'failed', error: reason });
  } finally {
    setPainting(job.imageId, false);
  }
}

function cleanTitle(title: string, subject: ImageSubject): string {
  const t = title.replace(/\s+/g, ' ').trim();
  if (!t) return DEFAULT_TITLE[subject];
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1).trimEnd()}…` : t;
}

/** Mark the newest in-memory entry for a picture failed (when it couldn't be saved at all). */
function failInMemory(imageId: string, error: string): void {
  const game = useGame.getState();
  const entry = game.log.findLast((e) => e.kind === 'image' && e.imageId === imageId);
  if (entry) void game.updateLog(entry.id, { status: 'failed', error }, { persist: false }).catch(() => {});
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Start painting an illustration for the LOADED campaign: appends a pending image log entry, then
 * generates, stores and marks it ready (or failed) in the background. Resolves as soon as the pending
 * entry exists. Never throws for expected problems (no key, images off): returns { ok: false, reason }.
 */
export async function requestIllustration(req: IllustrationRequest): Promise<IllustrationStart> {
  const settings = getSettings();
  const available = imagesAvailable(settings);
  if (!available.ok) return available;
  const game = useGame.getState();
  const campaign = game.campaign;
  if (!campaign || campaign.id !== req.campaignId) return { ok: false, reason: NOT_AT_TABLE };
  const description = (req.prompt ?? '').trim();
  if (!description) return { ok: false, reason: 'Describe what the picture shows: the description was empty.' };
  const subject: ImageSubject = Object.hasOwn(SUBJECT_FRAMING, req.subject) ? req.subject : 'scene';
  const aspect: ImageAspect = req.aspect && Object.hasOwn(IMAGE_SIZES, req.aspect) ? req.aspect : DEFAULT_ASPECT[subject];
  const title = cleanTitle(req.title ?? '', subject);
  const hero = game.character;
  const prompt = buildImagePrompt({
    prompt: description,
    subject,
    artStyle: campaignArtStyle(campaign),
    heroAppearance: hero && heroInFrame({ ...req, subject, title, prompt: description }, hero) ? describeHero(hero) : undefined,
    avoid: [...campaign.settings.lines, ...campaign.settings.veils],
  });

  const imageId = newId();
  // Before the entry exists, so its card never looks abandoned.
  setPainting(imageId, true);
  let entry: ImageLogEntry;
  try {
    const pending: NewLogEntry = { kind: 'image', imageId, title, subject, status: 'pending' };
    entry = (await game.appendLog(pending)) as ImageLogEntry;
  } catch (error) {
    setPainting(imageId, false);
    const reason = `The picture couldn't be added to the story: ${errorText(error)}`;
    failInMemory(imageId, reason);
    return { ok: false, reason };
  }
  const job: Job = { imageId, logEntryId: entry.id, campaignId: campaign.id, sessionId: entry.sessionId, title, subject, prompt, aspect };
  void paintInBackground(job, { ...settings.images });
  return { ok: true, imageId, logEntryId: entry.id };
}

/** Whether a failed picture can be painted again from this tab (it remembers the prompt). */
export function canRetryIllustration(imageId: string): boolean {
  return retryable.has(imageId);
}

/**
 * Paint a failed picture again (same entry, same prompt, the current key and model). Resolves once
 * the entry is pending again; false when this tab can't (unknown picture, or illustrations unavailable).
 */
export async function retryIllustration(imageId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const job = retryable.get(imageId);
  if (!job) return { ok: false, reason: 'This picture can’t be painted again from here. Ask the DM for a new one.' };
  const settings = getSettings();
  const available = imagesAvailable(settings);
  if (!available.ok) return available;
  retryable.delete(imageId);
  setPainting(imageId, true);
  await settle(job, { status: 'pending' });
  void paintInBackground(job, { ...settings.images });
  return { ok: true };
}
