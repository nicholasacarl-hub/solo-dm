/**
 * Illustrations: Claude writes the picture description, OpenAI's image model paints it (the player's
 * own OpenAI key, from Settings → Images). CONTRACT — implemented by the images engineer.
 *
 * Generation happens in the background: the story log shows a pending image card that turns into the
 * picture (or a friendly failure) when it's ready, so narration never waits on it.
 */
import type { Campaign, Character, ImageSubject, AppSettings } from '@/types';

export type ImageAspect = 'landscape' | 'portrait' | 'square';

export interface IllustrationRequest {
  campaignId: string;
  title: string;
  subject: ImageSubject;
  /** A vivid, specific visual description written by the DM (no text, captions, maps or UI). */
  prompt: string;
  aspect?: ImageAspect;
}

export type IllustrationStart =
  | { ok: true; imageId: string; logEntryId: string }
  | { ok: false; reason: string };

/** Whether illustrations can be made right now (a key is set and the frequency isn't "off"). */
export function imagesAvailable(_settings?: AppSettings): { ok: true } | { ok: false; reason: string } {
  throw new Error('images: imagesAvailable not implemented');
}

/**
 * Start painting an illustration for the LOADED campaign: appends a pending image log entry, then
 * generates, stores and marks it ready (or failed) in the background. Resolves as soon as the pending
 * entry exists. Never throws for expected problems (no key, images off): returns { ok: false, reason }.
 */
export async function requestIllustration(_req: IllustrationRequest): Promise<IllustrationStart> {
  throw new Error('images: requestIllustration not implemented');
}

/**
 * Paint a portrait of the hero from their sheet (species, class, appearance, gear) in the campaign's
 * art style. Stores the full image in the gallery and returns a small data: URL (≈256 px JPEG) to set
 * as Character.portrait.
 */
export async function generatePortrait(
  _character: Character,
  _campaign: Campaign,
  _signal?: AbortSignal,
): Promise<{ portrait: string; imageId: string }> {
  throw new Error('images: generatePortrait not implemented');
}

/** Check an OpenAI API key cheaply (no image is generated). */
export async function testOpenAiKey(_apiKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  throw new Error('images: testOpenAiKey not implemented');
}

/** The full prompt sent to the image model: art style + subject framing + description + guardrails. */
export function buildImagePrompt(_input: {
  prompt: string;
  subject: ImageSubject;
  artStyle?: string;
  /** The hero's appearance, when the hero is in frame. */
  heroAppearance?: string;
}): string {
  throw new Error('images: buildImagePrompt not implemented');
}
