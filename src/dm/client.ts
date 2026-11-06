/**
 * Anthropic client for the browser. The player brings their own API key (stored only in this
 * browser). `dangerouslyAllowBrowser` is required for direct browser calls; it is appropriate here
 * because the key belongs to the person using the page — it is never shipped to anyone else.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getSettings } from '@/state/settingsStore';
import { MODELS, type ModelId, type ModelInfo } from '@/types';

let cached: { key: string; client: Anthropic } | null = null;

export class MissingApiKeyError extends Error {
  constructor() {
    super('No Anthropic API key set. Add one in Settings to play with Claude as your DM.');
    this.name = 'MissingApiKeyError';
  }
}

/** A client for the given key (defaults to the key in Settings). Cached per key. */
export function getAnthropicClient(apiKey?: string): Anthropic {
  const key = (apiKey ?? getSettings().apiKey).trim();
  if (!key) throw new MissingApiKeyError();
  if (cached?.key === key) return cached.client;
  const client = new Anthropic({
    apiKey: key,
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
    timeout: 10 * 60 * 1000,
  });
  cached = { key, client };
  return client;
}

export function modelInfo(id: ModelId): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}
