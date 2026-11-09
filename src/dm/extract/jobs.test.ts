/**
 * The availability gate (spec §3.13): demo mode and a missing key refuse before anything is created or
 * sent, and the client factory is never called. Day-0 tests of the implemented gate; E2 adds the job API.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings } from '@/types';
import { extractionDeps, resetExtractionDeps, setExtractionDeps } from './deps';
import { ExtractionUnavailableError } from './errors';
import { extractionAvailability, resumeJob, retryRecords, startJob } from './jobs';

const settings = (patch: Partial<AppSettings>): AppSettings => ({ ...DEFAULT_SETTINGS, apiKey: 'sk-ant-test', ...patch });

afterEach(() => resetExtractionDeps());

describe('extractionAvailability', () => {
  it('says demo in demo mode, no-key without a key, ok otherwise', () => {
    expect(extractionAvailability(settings({ mockMode: true }))).toMatchObject({ ok: false, reason: 'demo' });
    expect(extractionAvailability(settings({ apiKey: '  ' }))).toMatchObject({ ok: false, reason: 'no-key' });
    expect(extractionAvailability(settings({}))).toEqual({ ok: true });
  });

  it('reads the injected settings by default', () => {
    setExtractionDeps({ settings: () => settings({ mockMode: true }) });
    expect(extractionAvailability()).toMatchObject({ reason: 'demo' });
  });
});

describe('the paid entry points', () => {
  it.each([
    ['demo', settings({ mockMode: true })],
    ['no-key', settings({ apiKey: '' })],
  ])('throw ExtractionUnavailableError(%s) without calling the client factory', async (reason, s) => {
    const client = vi.fn(() => {
      throw new Error('the client factory must not be called');
    });
    setExtractionDeps({ settings: () => s, client });
    for (const call of [() => startJob('gloam', { model: 'claude-opus-5-5', claudeFor: 'misses' }), () => resumeJob('job:1'), () => retryRecords('job:1', 'both')]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExtractionUnavailableError);
      expect((err as ExtractionUnavailableError).reason).toBe(reason);
    }
    expect(client).not.toHaveBeenCalled();
  });
});

describe('setExtractionDeps', () => {
  it('patches the deps and returns the previous set', () => {
    const before = extractionDeps();
    const previous = setExtractionDeps({ now: () => 42 });
    expect(previous).toBe(before);
    expect(extractionDeps().now()).toBe(42);
    setExtractionDeps(previous);
    expect(extractionDeps()).toEqual(before);
  });
});
