/**
 * Demo mode end to end (spec §8.4, §3.13): detection, offline reading, review and the builder work; nothing
 * reaches Claude — starting a job refuses before anything is created and the client factory is never
 * called; photo transcription is refused with the demo message.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import builderRaw from '../../../public/srd/builder.json?raw';
import compendiumRaw from '../../../public/srd/compendium.json?raw';
import { detectStructure, importLibraryDocument, loadBuilderData } from '@/data';
import { resetRulesIndex } from '@/data/rulesIndexStore';
import { resetSrdCache } from '@/data/srd';
import { ExtractionUnavailableError, startJob } from '@/dm';
import { resetExtractionDeps, setExtractionDeps } from '@/dm/extract/deps';
import { useSettings } from '@/state/settingsStore';
import { listJobs, listRecords } from '@/storage';
import { resetDatabase } from '@/storage/testData';
import { GLOAMWOOD_MD, GLOAMWOOD_TITLE } from '@/test/structuredFixtures';
import { acceptConfident, resetReviewActionsForTests } from '@/ui/library/structure/reviewActions';
import { DEFAULT_SETTINGS } from '@/types';

const clientFactory = vi.fn(() => {
  throw new Error('the Anthropic client must not be created in demo mode');
});

let sourceId = '';

beforeAll(async () => {
  await resetDatabase();
  resetSrdCache();
  resetRulesIndex();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => new Response(String(url).endsWith('compendium.json') ? compendiumRaw : builderRaw, { status: 200 })),
  );
  useSettings.getState().update({ mockMode: true, apiKey: 'sk-ant-demo-would-be-ignored' });
  setExtractionDeps({ client: clientFactory, settings: () => ({ ...DEFAULT_SETTINGS, mockMode: true, apiKey: 'sk-ant-demo-would-be-ignored' }) });
});

afterAll(() => {
  resetReviewActionsForTests();
  resetExtractionDeps();
  useSettings.getState().reset();
  vi.unstubAllGlobals();
});

describe('structured imports in demo mode (spec §8.4)', { timeout: 30_000 }, () => {
  it('imports and detects, reading what it can on this device', async () => {
    const source = await importLibraryDocument({ title: GLOAMWOOD_TITLE, format: 'markdown', text: GLOAMWOOD_MD });
    sourceId = source.id;
    await detectStructure(sourceId);
    const records = await listRecords(sourceId);
    expect(records.find((r) => r.name === 'Ashen Choir')?.data).not.toBeNull();
    // What would need Claude is "Not read yet", with a way to fill it in by hand.
    const unread = records.filter((r) => r.data === null && r.span !== 'table');
    for (const r of unread) expect(r.warnings.find((w) => w.code === 'needs-claude')?.severity, r.name).toBe('block');
  });

  it('refuses to start a job before creating anything, and never creates the client', async () => {
    await expect(startJob(sourceId, { model: 'claude-opus-5-5', claudeFor: 'misses' })).rejects.toBeInstanceOf(ExtractionUnavailableError);
    await expect(startJob(sourceId, { model: 'claude-opus-5-5', claudeFor: 'misses' })).rejects.toMatchObject({ reason: 'demo' });
    expect(await listJobs({ sourceId })).toEqual([]);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('lets the player review offline records into the builder', async () => {
    const { accepted } = await acceptConfident(sourceId);
    expect(accepted).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 650));
    const builder = await loadBuilderData();
    expect(builder.feats.find((f) => f.name === "Moth's Grace")?.source?.title).toBe(GLOAMWOOD_TITLE);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('refuses photo transcription with the demo message', async () => {
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'page-1.jpg', { type: 'image/jpeg' });
    await expect(importLibraryDocument({ title: 'Photos', format: 'image', files: [photo] })).rejects.toThrow(/Demo mode makes no API calls/);
    expect(clientFactory).not.toHaveBeenCalled();
  });
});
