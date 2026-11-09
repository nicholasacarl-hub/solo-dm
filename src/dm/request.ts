/**
 * The ONE place that builds a Messages API request for the DM. Audit checklist:
 * - model / max_tokens / effort from Settings; adaptive thinking only (no budgets, never disabled).
 * - thinking.block_binding.prefix_mismatch_behavior = "drop_block": an accidental history change
 *   degrades (drops thinking) instead of failing (beta thinking-binding-controls-2026-08-01).
 * - system = the session's frozen prompt with an explicit cache breakpoint; a top-level
 *   cache_control (same TTL) caches the growing conversation tail automatically.
 * - tools = the static DM_TOOLS array, every tool with eager_input_streaming.
 * - messages = the stored transcript, verbatim and append-only.
 * - Never sent: temperature / top_p / top_k, tool_choice any/tool, an assistant prefill.
 * - Server-side refusal fallbacks when enabled and supported by the model.
 * Requests outside the DM loop (extraction, transcription) are built in libraryRequests.ts under the same rules.
 */
import type { AnthropicBeta } from '@anthropic-ai/sdk/resources/beta/beta';
import type { MessageCreateParamsBase } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { MODELS, type AppSettings, type ModelId, type Session, type TranscriptMessage } from '@/types';
import { modelInfo } from './client';
import { DM_TOOLS } from './tools/definitions';

export const BETA_THINKING_BINDING = 'thinking-binding-controls-2026-08-01';
export const BETA_THINKING_UPDATES = 'thinking-display-updates-2026-08-18';
export const BETA_FALLBACKS = 'server-side-fallback-2026-07-01';

export function buildMessageRequest(
  settings: AppSettings,
  session: Pick<Session, 'systemPrompt'>,
  transcript: readonly TranscriptMessage[],
): MessageCreateParamsBase {
  const ttl = settings.cacheTtl;
  const useFallbacks = settings.useFallbacks && modelInfo(settings.model).supportsFallbacks;
  const betas: AnthropicBeta[] = [BETA_THINKING_BINDING];
  if (settings.thinkingDisplay === 'updates') betas.push(BETA_THINKING_UPDATES);
  if (useFallbacks) betas.push(BETA_FALLBACKS);

  return {
    model: settings.model,
    max_tokens: settings.maxTokens,
    thinking: {
      type: 'adaptive',
      display: settings.thinkingDisplay,
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    },
    output_config: { effort: settings.effort },
    system: [{ type: 'text', text: session.systemPrompt, cache_control: { type: 'ephemeral', ttl } }],
    cache_control: { type: 'ephemeral', ttl },
    tools: [...DM_TOOLS],
    messages: transcript.map((m) => m.param),
    betas,
    ...(useFallbacks ? { fallbacks: 'default' as const } : {}),
  };
}

/** Server-side refusal fallbacks for non-DM requests: Settings allow them and MODELS lists the model as supporting them. */
export function fallbackParams(model: ModelId, useFallbacks: boolean): { betas: AnthropicBeta[]; fallbacks?: 'default' } {
  const known = MODELS.find((m) => m.id === model);
  return useFallbacks && known?.supportsFallbacks ? { betas: [BETA_FALLBACKS], fallbacks: 'default' } : { betas: [] };
}
