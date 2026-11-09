/**
 * The ONE place that builds Messages API requests outside the DM loop (CLAUDE.md rule 4): library
 * extraction, and photo transcription (moved from data/vision.ts; vision.test.ts pins its output).
 * The DM's builder is request.ts. Audit checklist:
 * - model: the job's (the player's choice; default the Settings model).
 * - Known models (MODELS): thinking { type: 'adaptive', display: 'omitted' } and effort 'low'.
 *   Never a budget, never disabled. A custom model id gets neither (as vision.ts always did).
 * - system: the kind's static prompt, byte-identical per kind, with ONE 5-minute cache breakpoint.
 * - output_config.format: the kind's static wire schema via structuredFormat() — never built from book text.
 * - messages: ONE user message with the entry's blocks. No tools, no tool_choice, no assistant prefill.
 * - Never sent: temperature, top_p, top_k; no structured-outputs beta header (GA).
 * - Server-side refusal fallbacks via fallbackParams(): Settings allow them AND MODELS says the model supports them.
 * - Sent with client.beta.messages.stream(params, { signal, maxRetries: 0 }) from src/dm/extract/call.ts.
 *
 * Imports only ./request, ./extract/{format,prompts}, @/state/settingsStore, @/types and (through format)
 * the pure leaf @/data/structured/wire — never the @/data or @/dm barrels (src/test/layering.test.ts).
 */
import type { MessageCreateParamsBase, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { getSettings } from '@/state/settingsStore';
import { MODELS, type AppSettings, type ModelId, type StructuredKind } from '@/types';
import { extractionFormat } from './extract/format';
import { EXTRACT_SYSTEM, KIND_NOUN } from './extract/prompts';
import { fallbackParams } from './request';

/** Thinking + JSON. A max_tokens stop retries once at 2× (cap 32,000). */
export const EXTRACT_MAX_TOKENS: Readonly<Record<StructuredKind, number>> = {
  class: 16000, subclass: 8000, species: 8000, background: 4000, feat: 3000,
  spell: 4000, 'magic-item': 4000, item: 12000, monster: 6000,
};
export const EXTRACT_MAX_TOKENS_CAP = 32000;

export interface ExtractionBlock { id: string; title: string; path: string[]; paragraphs: string[]; abbreviated: boolean }
export interface ExtractionRequestInput {
  kind: StructuredKind;
  model: ModelId;
  useFallbacks: boolean;        // job.useFallbacks
  blocks: ExtractionBlock[];
  maxTokens?: number;           // record.runMaxTokens after a max_tokens stop
}

export const isKnownModel = (id: ModelId): boolean => MODELS.some((m) => m.id === id);

export function buildExtractionRequest(input: ExtractionRequestInput): MessageCreateParamsBase {
  const known = isKnownModel(input.model);
  const fb = fallbackParams(input.model, input.useFallbacks);
  return {
    model: input.model,
    max_tokens: Math.min(input.maxTokens ?? EXTRACT_MAX_TOKENS[input.kind], EXTRACT_MAX_TOKENS_CAP),
    ...(known ? { thinking: { type: 'adaptive' as const, display: 'omitted' as const } } : {}),
    output_config: { ...(known ? { effort: 'low' as const } : {}), format: extractionFormat(input.kind) },
    system: [{ type: 'text', text: EXTRACT_SYSTEM[input.kind], cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: renderBlocks(input.kind, input.blocks) }] }],
    ...(fb.betas.length ? { betas: fb.betas } : {}),
    ...(fb.fallbacks ? { fallbacks: fb.fallbacks } : {}),
  };
}

const attr = (s: string) => s.replace(/["<>]/g, '');
export function renderBlocks(kind: StructuredKind, blocks: readonly ExtractionBlock[]): string {
  const body = blocks
    .map((b) => {
      const paras = b.paragraphs.map((p, i) => `[p${i + 1}] ${p.replace(/<\/block/gi, '</ block')}`).join('\n');
      return `<block id="${b.id}" title="${attr(b.title)}" path="${attr(b.path.join(' › '))}"${b.abbreviated ? ' abbreviated="true"' : ''}>\n${paras}\n</block>`;
    })
    .join('\n\n');
  return `${body}\n\nLabel the ${KIND_NOUN[kind]} above.`;
}

/** Moved from vision.ts (which will re-export it from here). Base64 data, no data: prefix. */
export interface EncodedImage { data: string; mediaType: 'image/jpeg' }

/**
 * Photo transcription, moved unchanged from data/vision.ts:123-144 except that fallbacks come from fallbackParams().
 * Day-0 stub (not implemented): E2 moves the body here (with TRANSCRIBE_SYSTEM_PROMPT) and points vision.ts at it;
 * until then vision.ts keeps building its own request and nothing calls this.
 */
export function transcriptionRequest(image: EncodedImage, settings: AppSettings = getSettings()): MessageCreateParamsNonStreaming {
  void [image, settings];
  throw new Error('dm/libraryRequests: transcriptionRequest not implemented');
}
