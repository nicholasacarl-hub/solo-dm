/**
 * Illustrations: Claude writes the picture description, OpenAI's image model paints it (the player's
 * own OpenAI key, from Settings → Illustrations).
 *
 * Generation happens in the background: the story log shows a pending image card that turns into the
 * picture (or a friendly failure) when it's ready, so narration never waits on it. Pictures are stored
 * only on this device (see '@/storage': saveImage, useImageList, useImageUrl...).
 *
 * The OpenAI SDK is loaded on first use, so importing this module costs almost nothing.
 */
import { checkOpenAiKey } from './openai';
import { buildImagePrompt as buildPrompt, type ImagePromptInput } from './prompt';

export type { ImageAspect } from './openai';
export { IMAGE_SIZES } from './openai';
export type { IllustrationRequest, IllustrationStart } from './illustrate';
export {
  MAX_PARALLEL_PAINTINGS,
  NOT_AT_TABLE,
  canRetryIllustration,
  imagesAvailable,
  isPainting,
  requestIllustration,
  retryIllustration,
} from './illustrate';
export { generatePortrait, portraitPrompt } from './portrait';
export { IMAGE_DECLINED, OPENAI_UNREACHABLE, ImageServiceError } from './errors';
export type { ArtStylePreset, ImagePromptInput } from './prompt';
export {
  ART_STYLE_PRESETS,
  DEFAULT_ART_STYLE,
  IMAGE_GUARDRAILS,
  SUBJECT_FRAMING,
  campaignArtStyle,
  defaultArtStyle,
  describeHero,
  heroInFrame,
  toneArtStylePreset,
} from './prompt';
export type { PictureView } from './usePicture';
export { PICTURE_INTERRUPTED, PICTURE_MISSING, usePicture } from './usePicture';

/** Check an OpenAI API key cheaply (no image is generated). */
export async function testOpenAiKey(apiKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return checkOpenAiKey(apiKey);
}

/** The full prompt sent to the image model: art style + subject framing + description + guardrails. */
export function buildImagePrompt(input: ImagePromptInput): string {
  return buildPrompt(input);
}
