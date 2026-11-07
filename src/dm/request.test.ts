import { describe, expect, it, vi } from 'vitest';

vi.mock('@/engine', () => import('./testing/fakeEngine'));
vi.mock('@/data', () => import('./testing/fakeData'));
vi.mock('@/state/gameStore', () => import('./testing/fakeGameStoreModule'));

import { DEFAULT_SETTINGS, type AppSettings, type TranscriptMessage } from '@/types';
import { BETA_FALLBACKS, BETA_THINKING_BINDING, BETA_THINKING_UPDATES, buildMessageRequest } from './request';
import { DM_TOOLS } from './tools/definitions';

const transcript: TranscriptMessage[] = [
  { id: 't1', sessionId: 's', seq: 1, createdAt: 1, param: { role: 'user', content: [{ type: 'text', text: '<game_state>\n</game_state>' }, { type: 'text', text: 'Hi' }] } },
];

function request(settings: Partial<AppSettings> = {}) {
  return buildMessageRequest({ ...DEFAULT_SETTINGS, ...settings }, { systemPrompt: 'SYSTEM' }, transcript);
}

describe('buildMessageRequest', () => {
  it('builds the default request: adaptive thinking with drop_block, effort, cached system, auto-cached tail', () => {
    const r = request();
    expect(r.model).toBe('claude-opus-5-5');
    expect(r.max_tokens).toBe(32000);
    expect(r.thinking).toEqual({ type: 'adaptive', display: 'omitted', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(r.output_config).toEqual({ effort: 'medium' });
    expect(r.system).toEqual([{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect(r.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(r.betas).toEqual([BETA_THINKING_BINDING, BETA_FALLBACKS]);
    expect(r.fallbacks).toBe('default');
    expect(r.messages).toEqual([transcript[0].param]);
    expect(r.tools).toEqual(DM_TOOLS);
  });

  it('never sends sampling parameters, forced tool choice or a prefill', () => {
    const r = request() as unknown as Record<string, unknown>;
    for (const key of ['temperature', 'top_p', 'top_k', 'tool_choice', 'stop_sequences']) expect(r).not.toHaveProperty(key);
    expect(request().messages.at(-1)?.role).not.toBe('assistant');
  });

  it('adds the progress-updates beta only for display "updates"', () => {
    const r = request({ thinkingDisplay: 'updates' });
    expect(r.betas).toEqual([BETA_THINKING_BINDING, BETA_THINKING_UPDATES, BETA_FALLBACKS]);
    expect(r.thinking).toMatchObject({ display: 'updates' });
    expect(request({ thinkingDisplay: 'summarized' }).betas).not.toContain(BETA_THINKING_UPDATES);
  });

  it('opts into fallbacks only when enabled and the model supports them', () => {
    const haiku = request({ model: 'claude-haiku-5-5' });
    expect(haiku.betas).toEqual([BETA_THINKING_BINDING]);
    expect(haiku).not.toHaveProperty('fallbacks');
    const off = request({ useFallbacks: false });
    expect(off.betas).toEqual([BETA_THINKING_BINDING]);
    expect(off).not.toHaveProperty('fallbacks');
    expect(request({ model: 'claude-sonnet-5-5' }).fallbacks).toBe('default');
  });

  it('uses the chosen cache TTL for both breakpoints and the chosen effort, model and max tokens', () => {
    const r = request({ cacheTtl: '5m', effort: 'high', model: 'claude-sonnet-5-5', maxTokens: 16000 });
    expect(r.system).toEqual([{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral', ttl: '5m' } }]);
    expect(r.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    expect(r.output_config).toEqual({ effort: 'high' });
    expect(r.model).toBe('claude-sonnet-5-5');
    expect(r.max_tokens).toBe(16000);
  });

  it('sends the identical tools array every time', () => {
    expect(JSON.stringify(request().tools)).toBe(JSON.stringify(request({ effort: 'low' }).tools));
  });
});
