/**
 * show_image: the DM describes a picture and the player's OpenAI image model paints it in the
 * background (src/images): a pending card appears in the story log and turns into the picture (or
 * a friendly failure) when it's ready. The tool returns as soon as the card exists, so narration
 * never waits on the painting.
 */
import type { IllustrationRequest, IllustrationStart } from '@/images';
import { DEFAULT_IMAGE_SETTINGS, type LogEntry } from '@/types';
import { DmCancelledError } from '../errors';
import { illustrationMode } from '../modes';
import type { ToolInput } from './definitions';
import { defined, fail, ok, requireCampaign, type ToolContext, type ToolOutcome } from './context';

/** How long to wait for the pending picture to reach the log before carrying on regardless. */
export const IMAGE_START_TIMEOUT_MS = 10_000;

const QUIET_ABOUT_PICTURES =
  "Don't mention pictures unless the player asked for one; if they did, tell them in one short out-of-character line, and describe it in words instead.";

/** Why no picture can be made right now, or null when it can. */
function unavailableReason(ctx: ToolContext): string | null {
  const settings = ctx.deps.settings();
  if ((settings.images?.frequency ?? DEFAULT_IMAGE_SETTINGS.frequency) === 'off') {
    return 'the player has switched illustrations off (Settings → Illustrations)';
  }
  try {
    const check = ctx.deps.images.available(settings);
    return check.ok ? null : check.reason;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Pictures in the log since the current scene began (this one included). */
export function imagesThisScene(log: readonly LogEntry[], sessionId: string | null): number {
  let count = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.sessionId !== sessionId) break;
    if (entry.kind === 'tool' && entry.tool === 'set_scene' && entry.summary.startsWith('New scene')) break;
    if (entry.kind === 'image') count += 1;
  }
  return count;
}

/** Start the painting; give up waiting (not on the picture) after a while, or when the player stops. */
async function startPainting(ctx: ToolContext, req: IllustrationRequest): Promise<IllustrationStart | 'slow'> {
  if (ctx.signal.aborted) throw new DmCancelledError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const slow = new Promise<'slow'>((resolve) => {
    timer = setTimeout(() => resolve('slow'), IMAGE_START_TIMEOUT_MS);
  });
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DmCancelledError());
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([ctx.deps.images.request(req), slow, stopped]);
  } finally {
    clearTimeout(timer);
    if (onAbort) ctx.signal.removeEventListener('abort', onAbort);
  }
}

export async function showImageTool(input: ToolInput<'show_image'>, ctx: ToolContext): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  const campaign = requireCampaign(store);
  const reason = unavailableReason(ctx);
  if (reason) return fail(`No picture was made: ${reason}. ${QUIET_ABOUT_PICTURES}`);

  let started: IllustrationStart | 'slow';
  try {
    started = await startPainting(ctx, {
      campaignId: campaign.id,
      title: input.title.trim(),
      subject: input.subject,
      prompt: input.prompt.trim(),
      ...defined({ aspect: input.aspect, heroInFrame: input.hero_in_frame }),
    });
  } catch (err) {
    if (err instanceof DmCancelledError) throw err;
    const why = err instanceof Error ? err.message : String(err);
    return fail(`The picture couldn't be started (${why}). Carry on without it. ${QUIET_ABOUT_PICTURES}`);
  }
  if (started === 'slow') {
    return ok(`The picture "${input.title}" is slow to start; it may still appear in the log. Keep narrating — don't call show_image again for it, and don't describe the picture.`);
  }
  if (!started.ok) return fail(`No picture was made: ${started.reason}. ${QUIET_ABOUT_PICTURES}`);

  const lines = [`The picture "${input.title}" is being painted and will appear in the log when it's ready. Keep narrating — don't describe the picture or wait for it.`];
  const mode = illustrationMode(ctx.deps.settings(), ctx.deps.images.available);
  const thisScene = imagesThisScene(ctx.deps.store().log, store.activeSession?.id ?? null);
  if (mode === 'moments' && thisScene > 1) {
    lines.push(`That makes ${thisScene} pictures this scene: keep to about one per scene for key moments, unless the player asks.`);
  }
  return ok(lines.join(' '));
}
