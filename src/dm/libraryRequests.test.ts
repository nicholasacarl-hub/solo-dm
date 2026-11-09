/**
 * The non-DM request builder (spec §3.6, §8.2): extraction requests for every model family, the
 * cacheable prefix, block rendering and escaping, no book title, and photo transcription (moved from
 * data/vision.ts, byte for byte).
 */
import { describe, expect, it } from 'vitest';
import { segment } from '@/data/structured/segment';
import { GLOAMWOOD_TITLE, gloamwoodEntries } from '@/test/structuredFixtures';
import { DEFAULT_SETTINGS, STRUCTURED_KINDS, type AppSettings } from '@/types';
import { BETA_FALLBACKS, fallbackParams } from './request';
import {
  EXTRACT_MAX_TOKENS,
  TRANSCRIBE_SYSTEM_PROMPT,
  buildExtractionRequest,
  isKnownModel,
  renderBlocks,
  transcriptionRequest,
  type ExtractionBlock,
} from './libraryRequests';
import { extractionFormat } from './extract/format';
import { EXTRACT_SYSTEM } from './extract/prompts';

const blocks: ExtractionBlock[] = [
  { id: 'B1', title: 'Glimmerwing Drake', path: ['Bestiary', 'Glimmerwing Drake'], paragraphs: ['_Large Dragon, Unaligned_', '- **AC** 17'], abbreviated: false },
];
const base = (kind: 'monster' | 'spell' | 'class') => ({
  max_tokens: EXTRACT_MAX_TOKENS[kind],
  system: [{ type: 'text', text: EXTRACT_SYSTEM[kind], cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: renderBlocks(kind, blocks) }] }],
});

describe('buildExtractionRequest', () => {
  it('builds the Opus request: adaptive thinking (omitted), low effort, the kind schema, one cached system block, fallbacks', () => {
    expect(buildExtractionRequest({ kind: 'monster', model: 'claude-opus-5-5', useFallbacks: true, blocks })).toEqual({
      model: 'claude-opus-5-5',
      ...base('monster'),
      thinking: { type: 'adaptive', display: 'omitted' },
      output_config: { effort: 'low', format: extractionFormat('monster') },
      betas: [BETA_FALLBACKS],
      fallbacks: 'default',
    });
  });

  it('builds Sonnet without fallbacks when Settings turn them off', () => {
    expect(buildExtractionRequest({ kind: 'spell', model: 'claude-sonnet-5-5', useFallbacks: false, blocks })).toEqual({
      model: 'claude-sonnet-5-5',
      ...base('spell'),
      thinking: { type: 'adaptive', display: 'omitted' },
      output_config: { effort: 'low', format: extractionFormat('spell') },
    });
  });

  it('builds Haiku without fallbacks (it has none), and a custom model id with neither thinking nor effort', () => {
    expect(buildExtractionRequest({ kind: 'spell', model: 'claude-haiku-5-5', useFallbacks: true, blocks })).toEqual({
      model: 'claude-haiku-5-5',
      ...base('spell'),
      thinking: { type: 'adaptive', display: 'omitted' },
      output_config: { effort: 'low', format: extractionFormat('spell') },
    });
    expect(buildExtractionRequest({ kind: 'class', model: 'my-model', useFallbacks: true, blocks })).toEqual({
      model: 'my-model',
      ...base('class'),
      output_config: { format: extractionFormat('class') },
    });
  });

  it('caps a raised max_tokens and never sends sampling parameters, tools, a forced choice or a prefill', () => {
    for (const kind of STRUCTURED_KINDS) {
      const r = buildExtractionRequest({ kind, model: 'claude-opus-5-5', useFallbacks: true, blocks, maxTokens: 64000 });
      expect(r.max_tokens).toBe(32000);
      for (const key of ['temperature', 'top_p', 'top_k', 'tool_choice', 'tools', 'stop_sequences', 'cache_control']) expect(r).not.toHaveProperty(key);
      expect(r.messages).toHaveLength(1);
      expect(r.messages[0].role).toBe('user');
      expect(JSON.stringify(r).match(/cache_control/g)).toHaveLength(1);
      expect(r.betas ?? []).not.toContainEqual(expect.stringMatching(/structured-outputs/));
    }
    expect(buildExtractionRequest({ kind: 'feat', model: 'claude-opus-5-5', useFallbacks: true, blocks, maxTokens: 6000 }).max_tokens).toBe(6000);
  });

  it('keeps two requests of a kind identical outside messages (the cacheable prefix)', () => {
    const a = buildExtractionRequest({ kind: 'feat', model: 'claude-opus-5-5', useFallbacks: true, blocks });
    const b = buildExtractionRequest({ kind: 'feat', model: 'claude-opus-5-5', useFallbacks: true, blocks: [{ ...blocks[0], id: 'B2', title: 'Other' }] });
    expect(JSON.stringify({ ...a, messages: null })).toBe(JSON.stringify({ ...b, messages: null }));
    expect(a.output_config?.format).toBe(b.output_config?.format);
  });

  it("sends the book's blocks but never its title", () => {
    const { candidates } = segment(gloamwoodEntries(), { knownSpellNames: new Set(), knownClassNames: new Set() });
    for (const c of candidates) {
      const r = buildExtractionRequest({ kind: c.kind, model: 'claude-opus-5-5', useFallbacks: true, blocks: c.blocks.map((b) => ({ ...b, abbreviated: false })) });
      expect(JSON.stringify(r.messages), c.name).not.toContain(GLOAMWOOD_TITLE);
    }
  });
});

describe('renderBlocks', () => {
  it('numbers paragraphs, escapes a closing block tag and strips quotes and brackets from attributes', () => {
    const text = renderBlocks('monster', [{ id: 'B1', title: 'A "quoted" <title>', path: ['X', 'Y'], paragraphs: ['one', 'two </block> three'], abbreviated: true }]);
    expect(text).toBe('<block id="B1" title="A quoted title" path="X › Y" abbreviated="true">\n[p1] one\n[p2] two </ block> three\n</block>\n\nLabel the creature stat block above.');
    expect(renderBlocks('spell', [{ ...blocks[0], paragraphs: ['</BLOCK>'] }])).toContain('[p1] </ block>');
  });
});

describe('fallbackParams', () => {
  it('opts in only when Settings allow it and the model supports it', () => {
    expect(fallbackParams('claude-opus-5-5', true)).toEqual({ betas: [BETA_FALLBACKS], fallbacks: 'default' });
    expect(fallbackParams('claude-sonnet-5-5', true)).toEqual({ betas: [BETA_FALLBACKS], fallbacks: 'default' });
    expect(fallbackParams('claude-haiku-5-5', true)).toEqual({ betas: [] });
    expect(fallbackParams('claude-opus-5-5', false)).toEqual({ betas: [] });
    expect(fallbackParams('my-model', true)).toEqual({ betas: [] });
    expect(isKnownModel('claude-opus-5-5')).toBe(true);
    expect(isKnownModel('my-model')).toBe(false);
  });
});

describe('transcriptionRequest (moved from data/vision.ts)', () => {
  const image = { data: 'QUJD', mediaType: 'image/jpeg' as const };
  const settings = (patch: Partial<AppSettings>): AppSettings => ({ ...DEFAULT_SETTINGS, ...patch });

  it("equals the request vision.test.ts pins: the Settings model, low effort, fallbacks where supported", () => {
    expect(transcriptionRequest(image, settings({ model: 'claude-opus-5-5', useFallbacks: true }))).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 8000,
      system: TRANSCRIBE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
            { type: 'text', text: 'Transcribe this page.' },
          ],
        },
      ],
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  });

  it('sends no fallbacks for Haiku or when they are off, and no effort for a custom model', () => {
    expect(transcriptionRequest(image, settings({ model: 'claude-haiku-5-5', useFallbacks: true }))).not.toHaveProperty('fallbacks');
    expect(transcriptionRequest(image, settings({ model: 'claude-sonnet-5-5', useFallbacks: false }))).not.toHaveProperty('betas');
    const custom = transcriptionRequest(image, settings({ model: 'my-custom-model' }));
    expect(custom).not.toHaveProperty('output_config');
    for (const key of ['temperature', 'top_p', 'top_k', 'tool_choice', 'tools', 'thinking']) expect(custom).not.toHaveProperty(key);
  });
});
