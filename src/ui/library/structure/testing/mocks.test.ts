/**
 * Keeps the shared mock factories equal to the real barrels: every structured-imports name a barrel
 * exports is in its factory (and nothing else), so Library UI tests can't drift from @/data, @/storage
 * and @/dm.
 */
import { describe, expect, it } from 'vitest';
import * as data from '@/data';
import * as dm from '@/dm';
import * as fakeData from '@/dm/testing/fakeData';
import * as storage from '@/storage';
import {
  STRUCTURED_DATA_EXPORTS,
  STRUCTURED_DM_EXPORTS,
  STRUCTURED_STORAGE_EXPORTS,
  dmMock,
  gameStoreRestoreMock,
  structuredDataMock,
  structuredStorageMock,
} from './mocks';

describe('Library UI mock factories', () => {
  it.each([
    ['@/data', data as Record<string, unknown>, STRUCTURED_DATA_EXPORTS as readonly string[], structuredDataMock()],
    ['@/storage', storage as Record<string, unknown>, STRUCTURED_STORAGE_EXPORTS as readonly string[], structuredStorageMock()],
    ['@/dm', dm as Record<string, unknown>, STRUCTURED_DM_EXPORTS as readonly string[], dmMock()],
  ])('%s: the barrel exports every name, and the factory provides exactly them', (_name, barrel, names, mock) => {
    expect(names.filter((n) => !(n in barrel))).toEqual([]);
    expect(Object.keys(mock).sort()).toEqual([...names].sort());
    for (const n of names) expect(typeof (mock as Record<string, unknown>)[n], n).toBe(typeof barrel[n]);
  });

  it("keeps the DM tests' @/data stand-in (src/dm/testing/fakeData.ts) in step with the barrel", () => {
    expect(STRUCTURED_DATA_EXPORTS.filter((n) => !(n in fakeData))).toEqual([]);
  });

  it('mocks the game store action with a resolved null', async () => {
    await expect(gameStoreRestoreMock().restoreImportedText()).resolves.toBeNull();
  });
});
