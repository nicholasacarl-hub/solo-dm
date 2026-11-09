/**
 * Pins today's DM request bytes (spec §8.5 "unchanged without imports"; CLAUDE.md rule 1): the
 * structured-imports batch adds fallbackParams and the library request builders next to
 * buildMessageRequest without touching what it sends. The tools array is pinned separately by
 * tools/definitions.snapshot.test.ts (it changes once, by E1); here it is the token "<DM_TOOLS>" in its
 * place, so key order around it stays pinned. These strings are not snapshot files on purpose:
 * `vitest -u` can't rewrite them.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings, type TranscriptMessage } from '@/types';
import { fallbackParams, buildMessageRequest, BETA_FALLBACKS } from './request';
import { DM_TOOLS } from './tools/definitions';

const transcript: TranscriptMessage[] = [
  { id: 't1', sessionId: 's', seq: 1, createdAt: 1, param: { role: 'user', content: [{ type: 'text', text: '<game_state>\nround 1\n</game_state>' }, { type: 'text', text: 'I open the door.' }] } },
  { id: 't2', sessionId: 's', seq: 2, createdAt: 2, param: { role: 'assistant', content: [{ type: 'text', text: 'It creaks open.' }] } },
  { id: 't3', sessionId: 's', seq: 3, createdAt: 3, param: { role: 'user', content: [{ type: 'text', text: 'I step inside.' }] } },
];

const CASES: [string, Partial<AppSettings>, string][] = [
  [
    'the default settings',
    {},
    '{"model":"claude-opus-5-5","max_tokens":32000,"thinking":{"type":"adaptive","display":"omitted","block_binding":{"prefix_mismatch_behavior":"drop_block"}},"output_config":{"effort":"medium"},"system":[{"type":"text","text":"FROZEN SYSTEM PROMPT","cache_control":{"type":"ephemeral","ttl":"1h"}}],"cache_control":{"type":"ephemeral","ttl":"1h"},"tools":"<DM_TOOLS>","messages":[{"role":"user","content":[{"type":"text","text":"<game_state>\\nround 1\\n</game_state>"},{"type":"text","text":"I open the door."}]},{"role":"assistant","content":[{"type":"text","text":"It creaks open."}]},{"role":"user","content":[{"type":"text","text":"I step inside."}]}],"betas":["thinking-binding-controls-2026-08-01","server-side-fallback-2026-07-01"],"fallbacks":"default"}',
  ],
  [
    'Sonnet, progress updates, 5-minute cache, high effort, 16K tokens',
    { model: 'claude-sonnet-5-5', thinkingDisplay: 'updates', cacheTtl: '5m', effort: 'high', maxTokens: 16000 },
    '{"model":"claude-sonnet-5-5","max_tokens":16000,"thinking":{"type":"adaptive","display":"updates","block_binding":{"prefix_mismatch_behavior":"drop_block"}},"output_config":{"effort":"high"},"system":[{"type":"text","text":"FROZEN SYSTEM PROMPT","cache_control":{"type":"ephemeral","ttl":"5m"}}],"cache_control":{"type":"ephemeral","ttl":"5m"},"tools":"<DM_TOOLS>","messages":[{"role":"user","content":[{"type":"text","text":"<game_state>\\nround 1\\n</game_state>"},{"type":"text","text":"I open the door."}]},{"role":"assistant","content":[{"type":"text","text":"It creaks open."}]},{"role":"user","content":[{"type":"text","text":"I step inside."}]}],"betas":["thinking-binding-controls-2026-08-01","thinking-display-updates-2026-08-18","server-side-fallback-2026-07-01"],"fallbacks":"default"}',
  ],
  [
    'Haiku (no fallbacks), low effort',
    { model: 'claude-haiku-5-5', effort: 'low' },
    '{"model":"claude-haiku-5-5","max_tokens":32000,"thinking":{"type":"adaptive","display":"omitted","block_binding":{"prefix_mismatch_behavior":"drop_block"}},"output_config":{"effort":"low"},"system":[{"type":"text","text":"FROZEN SYSTEM PROMPT","cache_control":{"type":"ephemeral","ttl":"1h"}}],"cache_control":{"type":"ephemeral","ttl":"1h"},"tools":"<DM_TOOLS>","messages":[{"role":"user","content":[{"type":"text","text":"<game_state>\\nround 1\\n</game_state>"},{"type":"text","text":"I open the door."}]},{"role":"assistant","content":[{"type":"text","text":"It creaks open."}]},{"role":"user","content":[{"type":"text","text":"I step inside."}]}],"betas":["thinking-binding-controls-2026-08-01"]}',
  ],
  [
    'fallbacks off, summarized thinking, max effort',
    { useFallbacks: false, thinkingDisplay: 'summarized', effort: 'max' },
    '{"model":"claude-opus-5-5","max_tokens":32000,"thinking":{"type":"adaptive","display":"summarized","block_binding":{"prefix_mismatch_behavior":"drop_block"}},"output_config":{"effort":"max"},"system":[{"type":"text","text":"FROZEN SYSTEM PROMPT","cache_control":{"type":"ephemeral","ttl":"1h"}}],"cache_control":{"type":"ephemeral","ttl":"1h"},"tools":"<DM_TOOLS>","messages":[{"role":"user","content":[{"type":"text","text":"<game_state>\\nround 1\\n</game_state>"},{"type":"text","text":"I open the door."}]},{"role":"assistant","content":[{"type":"text","text":"It creaks open."}]},{"role":"user","content":[{"type":"text","text":"I step inside."}]}],"betas":["thinking-binding-controls-2026-08-01"]}',
  ],
  [
    'a custom model id (modelInfo falls back to the first model, as today)',
    { model: 'my-custom-model' },
    '{"model":"my-custom-model","max_tokens":32000,"thinking":{"type":"adaptive","display":"omitted","block_binding":{"prefix_mismatch_behavior":"drop_block"}},"output_config":{"effort":"medium"},"system":[{"type":"text","text":"FROZEN SYSTEM PROMPT","cache_control":{"type":"ephemeral","ttl":"1h"}}],"cache_control":{"type":"ephemeral","ttl":"1h"},"tools":"<DM_TOOLS>","messages":[{"role":"user","content":[{"type":"text","text":"<game_state>\\nround 1\\n</game_state>"},{"type":"text","text":"I open the door."}]},{"role":"assistant","content":[{"type":"text","text":"It creaks open."}]},{"role":"user","content":[{"type":"text","text":"I step inside."}]}],"betas":["thinking-binding-controls-2026-08-01","server-side-fallback-2026-07-01"],"fallbacks":"default"}',
  ],
];

describe('buildMessageRequest bytes (pinned)', () => {
  it.each(CASES)('%s', (_label, settings, expected) => {
    const request = buildMessageRequest({ ...DEFAULT_SETTINGS, ...settings }, { systemPrompt: 'FROZEN SYSTEM PROMPT' }, transcript);
    expect(JSON.stringify({ ...request, tools: '<DM_TOOLS>' })).toBe(expected);
    expect(JSON.stringify(request.tools)).toBe(JSON.stringify(DM_TOOLS));
  });
});

describe('fallbackParams (non-DM requests)', () => {
  it('opts in only when Settings allow it and MODELS says the model supports it', () => {
    expect(fallbackParams('claude-opus-5-5', true)).toEqual({ betas: [BETA_FALLBACKS], fallbacks: 'default' });
    expect(fallbackParams('claude-sonnet-5-5', true)).toEqual({ betas: [BETA_FALLBACKS], fallbacks: 'default' });
    expect(fallbackParams('claude-haiku-5-5', true)).toEqual({ betas: [] });
    expect(fallbackParams('claude-opus-5-5', false)).toEqual({ betas: [] });
    // Unlike the DM builder's modelInfo fallback, an unknown id never gets fallbacks.
    expect(fallbackParams('my-custom-model', true)).toEqual({ betas: [] });
  });
});
