/**
 * Photo imports: each photo of a book page is downscaled, re-encoded as JPEG and transcribed to
 * Markdown by Claude (vision) with the player's own API key: one request per photo, started only
 * when the player imports photos. Loaded on demand by the import pipeline.
 */
import {
  APIError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { getAnthropicClient } from '@/dm/client';
import { transcriptionRequest, type EncodedImage } from '@/dm/libraryRequests';
import { getSettings } from '@/state/settingsStore';
import { abortError, throwIfAborted } from './text';

/** The request builder lives with the other non-DM requests (src/dm/libraryRequests.ts); re-exported for callers here. */
export { TRANSCRIBE_SYSTEM_PROMPT, transcriptionRequest, type EncodedImage } from '@/dm/libraryRequests';

/** transcribeImages refuses in demo mode (defense in depth: the import dialog refuses photos there first). */
export const DEMO_PHOTO_MESSAGE = 'Demo mode makes no API calls. Turn it off in Settings to transcribe photos.';
/** …and without an API key, before any client is created (the import dialog asks for a key first). */
export const NO_KEY_PHOTO_MESSAGE = 'Transcribing photos needs your Anthropic API key. Add it in Settings first.';

/** Claude's recommended maximum image edge; larger images are downscaled server-side anyway. */
export const MAX_IMAGE_SIDE = 1568;
const JPEG_QUALITY = 0.85;

/** The part of the Anthropic client this module uses (the real client satisfies it). */
export interface TranscriptionClient {
  beta: {
    messages: {
      create(params: MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): PromiseLike<BetaMessage>;
    };
  };
}

export interface TranscribeOptions {
  signal?: AbortSignal;
  /** Called before each photo (done = photos finished so far). */
  onProgress?: (done: number, total: number, message: string) => void;
  /** Defaults to the client for the API key in Settings. */
  client?: TranscriptionClient;
  /** Defaults to downscaling with a canvas and encoding as JPEG. */
  encode?: (file: Blob) => Promise<EncodedImage>;
}

export interface TranscriptionResult {
  /** All pages' Markdown, in order. */
  markdown: string;
  /** Pages that were refused, cut off or empty. */
  warnings: string[];
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

async function drawJpeg(bitmap: ImageBitmap, width: number, height: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("This browser can't prepare images for upload.");
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("This browser can't prepare images for upload.");
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image.'))), 'image/jpeg', JPEG_QUALITY),
  );
}

/** Downscale so the longest side is at most MAX_IMAGE_SIDE (EXIF rotation applied) and encode as JPEG. */
export async function encodeImageForClaude(file: Blob): Promise<EncodedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error("This browser can't read that image format. Try a JPEG or PNG photo.");
  }
  try {
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    return { data: await blobToBase64(await drawJpeg(bitmap, width, height)), mediaType: 'image/jpeg' };
  } finally {
    bitmap.close();
  }
}

/** Text blocks of a response, without a wrapping ```markdown fence. */
function responseText(message: BetaMessage): string {
  const text = message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

function friendlyError(err: unknown, photo: number): Error {
  if (err instanceof APIUserAbortError) return abortError();
  if (err instanceof AuthenticationError) return new Error('Claude rejected the API key. Check it in Settings.');
  if (err instanceof PermissionDeniedError) {
    return new Error("This API key can't use the selected model. Pick another model in Settings.");
  }
  if (err instanceof RateLimitError) return new Error('Claude is rate-limiting requests right now. Wait a minute, then import again.');
  if (err instanceof APIError) return new Error(`Claude couldn't transcribe photo ${photo}: ${err.message}`);
  return err instanceof Error ? err : new Error(String(err));
}

/** Transcribe photos of book pages to Markdown, one Claude request per photo. */
export async function transcribeImages(files: Blob[], opts: TranscribeOptions = {}): Promise<TranscriptionResult> {
  const { signal, onProgress } = opts;
  const settings = getSettings();
  if (settings.mockMode) throw new Error(DEMO_PHOTO_MESSAGE);
  if (!opts.client && !settings.apiKey.trim()) throw new Error(NO_KEY_PHOTO_MESSAGE);
  const encode = opts.encode ?? encodeImageForClaude;
  const client = opts.client ?? getAnthropicClient();
  const pages: string[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const photo = i + 1;
    throwIfAborted(signal);
    onProgress?.(i, files.length, `Transcribing photo ${photo} of ${files.length}…`);
    const image = await encode(files[i]);
    throwIfAborted(signal);
    let message: BetaMessage;
    try {
      message = await client.beta.messages.create(transcriptionRequest(image), { signal });
    } catch (err) {
      throw signal?.aborted ? abortError() : friendlyError(err, photo);
    }
    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category;
      warnings.push(`Photo ${photo} was skipped: Claude declined to transcribe it${category ? ` (${category})` : ''}.`);
      continue;
    }
    const text = responseText(message);
    if (message.stop_reason === 'max_tokens') warnings.push(`Photo ${photo} may be incomplete: the transcription hit the length limit.`);
    if (!text) {
      warnings.push(`Photo ${photo}: no text was found.`);
      continue;
    }
    pages.push(text);
  }
  onProgress?.(files.length, files.length, 'Transcription finished.');
  if (!pages.length) {
    throw new Error(warnings.length ? `Nothing could be transcribed. ${warnings.join(' ')}` : 'Nothing could be transcribed.');
  }
  return { markdown: pages.join('\n\n'), warnings };
}
