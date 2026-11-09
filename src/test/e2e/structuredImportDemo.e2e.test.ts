/**
 * Demo mode end to end (spec §8.4, §3.13): detection, offline reading, review and the builder work; nothing
 * reaches Claude — starting a job refuses before anything is created and the client factory is never
 * called; what the offline reader can't read is "Not read yet" and can be filled in by hand; photo
 * transcription is refused with the demo message.
 *
 * The mixed dialect (src/test/structuredFixtures.ts): the Wickwright chapter, the drake and Mothkin are
 * flattened the way PDFs are, so they wait for Claude, while the Markdown entries are read on the device.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import builderRaw from '../../../public/srd/builder.json?raw';
import compendiumRaw from '../../../public/srd/compendium.json?raw';
import { detectStructure, importLibraryDocument, loadBuilderData } from '@/data';
import { NEEDS_CLAUDE_MESSAGE } from '@/data/structured/detect';
import { resetRulesIndex } from '@/data/rulesIndexStore';
import { resetSrdCache } from '@/data/srd';
import { ExtractionUnavailableError, startJob } from '@/dm';
import { resetExtractionDeps, setExtractionDeps } from '@/dm/extract/deps';
import { useSettings } from '@/state/settingsStore';
import { listJobs, listRecords } from '@/storage';
import { resetDatabase } from '@/storage/testData';
import { expectedData, GLOAMWOOD_MIXED, GLOAMWOOD_TITLE } from '@/test/structuredFixtures';
import { acceptConfident, acceptRecords, resetReviewActionsForTests, saveRecordEdit } from '@/ui/library/structure/reviewActions';
import { DEFAULT_SETTINGS } from '@/types';

const clientFactory = vi.fn(() => {
  throw new Error('the Anthropic client must not be created in demo mode');
});

let sourceId = '';

/** Wait for the review actions' debounced refresh (500 ms) to land. */
const settleRefresh = () => new Promise((resolve) => setTimeout(resolve, 650));

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
    const source = await importLibraryDocument({ title: GLOAMWOOD_TITLE, format: 'markdown', text: GLOAMWOOD_MIXED });
    sourceId = source.id;
    await detectStructure(sourceId);
    const records = await listRecords(sourceId);
    expect(records.find((r) => r.name === 'Ashen Choir')?.data).not.toBeNull();
    // What would need Claude is "Not read yet", with a way to fill it in by hand.
    const unread = records.filter((r) => r.data === null && r.span !== 'table');
    expect(unread.map((r) => r.name)).toEqual(expect.arrayContaining(['Wickwright', 'Glimmerwing Drake', 'Mothkin']));
    for (const r of unread) {
      const warning = r.warnings.find((w) => w.code === 'needs-claude');
      expect(warning, r.name).toMatchObject({ severity: 'block', message: NEEDS_CLAUDE_MESSAGE });
    }
    expect(NEEDS_CLAUDE_MESSAGE).toMatch(/^Not read yet: fill it in by hand/);
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
    await settleRefresh();
    const builder = await loadBuilderData();
    expect(builder.feats.find((f) => f.name === "Moth's Grace")?.source?.title).toBe(GLOAMWOOD_TITLE);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('lets the player fill in what was not read ("Fill in yourself") and use it, with no API call', async () => {
    const wick = (await listRecords(sourceId)).find((r) => r.name === 'Wickwright');
    if (!wick) throw new Error('no Wickwright record');
    expect(wick.data).toBeNull();
    const filled = await saveRecordEdit(wick, expectedData(sourceId).Wickwright);
    expect(filled.warnings.some((w) => w.severity === 'block')).toBe(false);
    const { accepted, skipped } = await acceptRecords([wick.id]);
    expect({ accepted, skipped }).toEqual({ accepted: 1, skipped: [] });
    await settleRefresh();
    const builder = await loadBuilderData();
    expect(builder.classes.find((c) => c.name === 'Wickwright')?.source?.title).toBe(GLOAMWOOD_TITLE);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('refuses photo transcription with the demo message', async () => {
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'page-1.jpg', { type: 'image/jpeg' });
    await expect(importLibraryDocument({ title: 'Photos', format: 'image', files: [photo] })).rejects.toThrow(/Demo mode makes no API calls/);
    expect(clientFactory).not.toHaveBeenCalled();
  });
});
