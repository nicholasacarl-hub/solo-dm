/**
 * OpenAI's image API through the official SDK, loaded only when a picture is first needed (it is a
 * separate chunk). The player brings their own key, so `dangerouslyAllowBrowser` is appropriate: the
 * key belongs to the person using the page and is only ever sent to api.openai.com.
 *
 * GPT image models always answer with base64 (`data[0].b64_json`); `response_format` is unsupported.
 */
import type { ImageGenerateParamsNonStreaming } from 'openai/resources/images';
import type { ImageSettings } from '@/types';
import { describeImageError, describeKeyTestError, ImageServiceError, type OpenAiErrorClasses } from './errors';

type OpenAiSdk = typeof import('openai');

export type ImageAspect = 'landscape' | 'portrait' | 'square';

/** Standard sizes every GPT image model supports. */
export const IMAGE_SIZES: Record<ImageAspect, '1536x1024' | '1024x1536' | '1024x1024'> = {
  landscape: '1536x1024',
  portrait: '1024x1536',
  square: '1024x1024',
};

export type ImageFormat = 'webp' | 'jpeg';

/** Pictures are painted for a while: allow minutes, and retry a failed request only once. */
const PAINT_TIMEOUT_MS = 5 * 60_000;
const PAINT_RETRIES = 1;
const KEY_TEST_TIMEOUT_MS = 20_000;
/** webp/jpeg compression (100 = largest files); 85 keeps pictures sharp at a fraction of the size. */
const OUTPUT_COMPRESSION = 85;

let sdk: Promise<OpenAiSdk> | null = null;

/** The SDK module, imported on first use (a failed import is retried next time). */
export function loadOpenAiSdk(): Promise<OpenAiSdk> {
  sdk ??= import('openai').catch((error: unknown) => {
    sdk = null;
    throw error;
  });
  return sdk;
}

/** The SDK's error classes, or null when the SDK can't be loaded. */
async function errorClasses(): Promise<OpenAiErrorClasses | null> {
  try {
    return await loadOpenAiSdk();
  } catch {
    return null;
  }
}

async function client(apiKey: string, opts: { timeout: number; maxRetries: number }) {
  const { OpenAI } = await loadOpenAiSdk();
  return new OpenAI({ apiKey, dangerouslyAllowBrowser: true, timeout: opts.timeout, maxRetries: opts.maxRetries });
}

function base64Bytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface PaintRequest {
  apiKey: string;
  settings: Pick<ImageSettings, 'model' | 'quality'>;
  /** The full prompt (see buildImagePrompt). */
  prompt: string;
  aspect: ImageAspect;
  format?: ImageFormat;
  signal?: AbortSignal;
}

export interface Painting {
  blob: Blob;
  mime: string;
}

/** Paint one picture. Throws the SDK's errors (see explainPaintError) or an ImageServiceError. */
export async function paint(request: PaintRequest): Promise<Painting> {
  const openai = await client(request.apiKey, { timeout: PAINT_TIMEOUT_MS, maxRetries: PAINT_RETRIES });
  const format = request.format ?? 'webp';
  const params: ImageGenerateParamsNonStreaming = {
    model: request.settings.model,
    prompt: request.prompt,
    size: IMAGE_SIZES[request.aspect],
    quality: request.settings.quality,
    output_format: format,
    output_compression: OUTPUT_COMPRESSION,
    n: 1,
  };
  const response = await openai.images.generate(params, { signal: request.signal });
  const base64 = response.data?.[0]?.b64_json;
  if (!base64) throw new ImageServiceError('OpenAI sent back no picture. Try again.');
  const actual = response.output_format;
  const mime = `image/${actual === 'png' || actual === 'jpeg' || actual === 'webp' ? actual : format}`;
  return { blob: new Blob([base64Bytes(base64)], { type: mime }), mime };
}

/** Friendly text for anything paint() threw. */
export async function explainPaintError(error: unknown, model: string): Promise<string> {
  return describeImageError(error, await errorClasses(), model);
}

/** Check a key with a cheap call that paints nothing (the model list). */
export async function checkOpenAiKey(apiKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const key = apiKey.trim();
  if (!key) return { ok: false, error: 'Enter your OpenAI API key first.' };
  try {
    const openai = await client(key, { timeout: KEY_TEST_TIMEOUT_MS, maxRetries: 1 });
    await openai.models.list();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeKeyTestError(error, await errorClasses()) };
  }
}
