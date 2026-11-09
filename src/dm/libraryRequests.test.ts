/**
 * The extraction request builder (spec §3.6). Day-0 checks of the exact code; E2 extends this file with
 * the full §8.2 list (transcriptionRequest once it moves here, every model).
 */
import { describe, expect, it } from 'vitest';
import { BETA_FALLBACKS } from './request';
import { EXTRACT_MAX_TOKENS, buildExtractionRequest, renderBlocks, type ExtractionBlock } from './libraryRequests';
import { extractionFormat } from './extract/format';
import { EXTRACT_SYSTEM } from './extract/prompts';

const blocks: ExtractionBlock[] = [
  { id: 'B1', title: 'Glimmerwing Drake', path: ['Bestiary', 'Glimmerwing Drake'], paragraphs: ['_Large Dragon, Unaligned_', '- **AC** 17'], abbreviated: false },
];

describe('buildExtractionRequest', () => {
  it('builds the Opus request: adaptive thinking (omitted), low effort, the kind schema, one cached system block, fallbacks', () => {
    expect(buildExtractionRequest({ kind: 'monster', model: 'claude-opus-5-5', useFallbacks: true, blocks })).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: EXTRACT_MAX_TOKENS.monster,
      thinking: { type: 'adaptive', display: 'omitted' },
      output_config: { effort: 'low', format: extractionFormat('monster') },
      system: [{ type: 'text', text: EXTRACT_SYSTEM.monster, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: renderBlocks('monster', blocks) }] }],
      betas: [BETA_FALLBACKS],
      fallbacks: 'default',
    });
  });

  it('sends no thinking, effort or fallbacks for a custom model id, and no fallbacks for Haiku', () => {
    const custom = buildExtractionRequest({ kind: 'spell', model: 'my-model', useFallbacks: true, blocks });
    expect(custom).not.toHaveProperty('thinking');
    expect(custom.output_config).toEqual({ format: extractionFormat('spell') });
    expect(custom).not.toHaveProperty('betas');
    const haiku = buildExtractionRequest({ kind: 'spell', model: 'claude-haiku-5-5', useFallbacks: true, blocks });
    expect(haiku).not.toHaveProperty('fallbacks');
    expect(haiku.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
  });

  it('caps a raised max_tokens and never sends sampling parameters, tools or a prefill', () => {
    const r = buildExtractionRequest({ kind: 'class', model: 'claude-sonnet-5-5', useFallbacks: false, blocks, maxTokens: 64000 });
    expect(r.max_tokens).toBe(32000);
    for (const key of ['temperature', 'top_p', 'top_k', 'tool_choice', 'tools', 'stop_sequences']) expect(r).not.toHaveProperty(key);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].role).toBe('user');
  });

  it('keeps two requests of a kind identical outside messages (the cacheable prefix)', () => {
    const a = buildExtractionRequest({ kind: 'feat', model: 'claude-opus-5-5', useFallbacks: true, blocks });
    const b = buildExtractionRequest({ kind: 'feat', model: 'claude-opus-5-5', useFallbacks: true, blocks: [{ ...blocks[0], id: 'B2', title: 'Other' }] });
    expect(JSON.stringify({ ...a, messages: null })).toBe(JSON.stringify({ ...b, messages: null }));
  });
});

describe('renderBlocks', () => {
  it('numbers paragraphs, escapes a closing block tag and strips quotes and brackets from attributes', () => {
    const text = renderBlocks('monster', [{ id: 'B1', title: 'A "quoted" <title>', path: ['X', 'Y'], paragraphs: ['one', 'two </block> three'], abbreviated: true }]);
    expect(text).toBe('<block id="B1" title="A quoted title" path="X › Y" abbreviated="true">\n[p1] one\n[p2] two </ block> three\n</block>\n\nLabel the creature stat block above.');
  });
});
