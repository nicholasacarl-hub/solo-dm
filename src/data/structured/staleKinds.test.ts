/**
 * The correction of entry kinds the first chunker guessed wrongly (staleKinds.ts), over fake-indexeddb:
 * imported text only, conservative (a real older-style feat stays a feat), idempotent, refreshes the
 * rules index only when something changed, and never throws. Invented content only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSourceEntries, saveLibrarySource } from '@/storage';
import { resetDatabase } from '@/storage/testData';
import type { CompendiumEntry, LibrarySource } from '@/types';
import { correctStaleKinds } from './staleKinds';

const invalidate = vi.hoisted(() => vi.fn());
vi.mock('../rulesIndexStore', () => ({ invalidateRulesIndex: invalidate }));

const source = (id: string, format: LibrarySource['format'], kind: LibrarySource['kind'] = 'import'): LibrarySource => ({
  id, title: 'Lamplight Holdings', kind, format, enabled: true, entryCount: 4, createdAt: 1, updatedAt: 1,
});
const entry = (sourceId: string, n: number, name: string, kind: CompendiumEntry['kind'], text: string, section: string, summary?: string): CompendiumEntry => ({
  id: `lib:${sourceId}:${n}`, sourceId, sourceName: 'Lamplight Holdings', kind, name, text, path: ['Lamplight Holdings', section, name], ...(summary ? { summary } : {}),
});
/** As the first chunker stored them. */
const stored = (sourceId: string) => [
  entry(sourceId, 1, 'Glowworm Gallery', 'feat', '_Level 5 Holding Room_\n\n_Prerequisite: None_\n\nThe keeper raises glowworms.', 'Holding Rooms', 'Prerequisite: None'),
  entry(sourceId, 2, 'Moth Archive', 'feat', `_Level 9 Holding Room_\n\n_Prerequisite: None_\n\n${'Moths copy maps. '.repeat(5)}`, 'Holding Rooms', 'Prerequisite: None'),
  entry(sourceId, 3, 'Moth Archive (part 2)', 'feat', 'The keeper sells the copies.', 'Holding Rooms', 'Prerequisite: None'),
  // A real older-style feat whose Feats heading the import lost: it stays a feat.
  entry(sourceId, 4, 'Night Walker', 'feat', '_Prerequisite: Wisdom 13 or higher_\n\nYou walk the lamp roads at night.', 'Heroic Talents', 'Prerequisite: Wisdom 13 or higher'),
];
const kinds = async (sourceId: string) => Object.fromEntries((await getSourceEntries(sourceId)).map((e) => [e.name, [e.kind, e.summary]]));

beforeEach(async () => {
  await resetDatabase();
  invalidate.mockClear();
});

describe('correctStaleKinds', () => {
  it('corrects imported text, keeps real feats, and leaves JSON files and built-in sources alone', async () => {
    await saveLibrarySource(source('pdf', 'pdf'), stored('pdf'));
    await saveLibrarySource(source('notes', undefined), stored('notes'));
    await saveLibrarySource(source('file', 'json'), stored('file'));
    await saveLibrarySource(source('builtin', 'markdown', 'builtin'), stored('builtin'));

    expect(await correctStaleKinds()).toBe(6);
    const fixed = {
      'Glowworm Gallery': ['rule', 'Lamplight Holdings › Holding Rooms'],
      'Moth Archive': ['rule', 'Lamplight Holdings › Holding Rooms'],
      'Moth Archive (part 2)': ['rule', 'Lamplight Holdings › Holding Rooms'],
      'Night Walker': ['feat', 'Prerequisite: Wisdom 13 or higher'],
    };
    expect(await kinds('pdf')).toEqual(fixed);
    expect(await kinds('notes')).toEqual(fixed); // an import from before formats were recorded
    const untouched = Object.fromEntries(stored('file').map((e) => [e.name, [e.kind, e.summary]]));
    expect(await kinds('file')).toEqual(untouched);
    expect(await kinds('builtin')).toEqual(untouched);
    expect(invalidate).toHaveBeenCalledTimes(1);

    // Once corrected, nothing more to do (and the index is left alone).
    expect(await correctStaleKinds()).toBe(0);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('corrects one book when asked to', async () => {
    await saveLibrarySource(source('pdf', 'pdf'), stored('pdf'));
    await saveLibrarySource(source('other', 'pdf'), stored('other'));
    expect(await correctStaleKinds('pdf')).toBe(3);
    expect((await kinds('other'))['Glowworm Gallery']).toEqual(['feat', 'Prerequisite: None']);
  });

  it('keeps the kinds of a book whose old entries it cannot read, and never throws', async () => {
    const broken = { ...stored('odd')[0], text: null } as unknown as CompendiumEntry;
    await saveLibrarySource(source('odd', 'pdf'), [broken]);
    await saveLibrarySource(source('pdf', 'pdf'), stored('pdf'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await correctStaleKinds()).toBe(3);
    expect((await getSourceEntries('odd'))[0].kind).toBe('feat');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
