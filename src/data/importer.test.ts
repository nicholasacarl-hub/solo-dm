import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompendiumEntry, LibrarySource } from '@/types';

vi.mock('@/storage', () => ({ saveLibrarySource: vi.fn(async () => {}), saveLibrarySourceWithRecords: vi.fn(async () => {}) }));
vi.mock('./rulesIndexStore', () => ({ invalidateRulesIndex: vi.fn() }));
vi.mock('./pdf', () => ({ extractPdfMarkdown: vi.fn() }));
vi.mock('./vision', () => ({ transcribeImages: vi.fn() }));

import { bookFingerprint } from '@/lib/importedContent';
import { saveLibrarySource, saveLibrarySourceWithRecords } from '@/storage';
import { gloamwoodEntries, gloamwoodRecords, gloamwoodSource } from '@/test/structuredFixtures';
import { importLibraryDocument } from './importer';
import { exportPack, parsePack } from './structured/packs';
import { extractPdfMarkdown } from './pdf';
import { invalidateRulesIndex } from './rulesIndexStore';
import { transcribeImages } from './vision';
import type { ImportProgress } from './index';

const save = vi.mocked(saveLibrarySource);
const saved = () => save.mock.calls[0] as [LibrarySource, CompendiumEntry[]];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('importLibraryDocument', () => {
  it('chunks pasted Markdown, saves an enabled source and refreshes the rules index', async () => {
    const progress: ImportProgress[] = [];
    const source = await importLibraryDocument(
      { title: '  Arcane Notes ', format: 'markdown', text: '# Wild Magic\nSurges happen.\n\n# Spell Points\nSpend points.', notes: 'From my table' },
      (p) => progress.push(p),
    );
    expect(source).toMatchObject({ title: 'Arcane Notes', kind: 'import', format: 'markdown', enabled: true, entryCount: 2, notes: 'From my table' });
    expect(source.id).toMatch(/^import-[0-9a-f]{12}$/);
    const [savedSource, entries] = saved();
    expect(savedSource).toBe(source);
    expect(entries.map((e) => [e.id, e.name, e.sourceName])).toEqual([
      [`lib:${source.id}:1`, 'Wild Magic', 'Arcane Notes'],
      [`lib:${source.id}:2`, 'Spell Points', 'Arcane Notes'],
    ]);
    expect(invalidateRulesIndex).toHaveBeenCalledTimes(1);
    expect(progress.map((p) => p.stage)).toEqual(['chunking', 'saving', 'done']);
    expect(progress.at(-1)?.message).toBe('Imported 2 entries.');
  });

  it('reads text files, giving each untitled file its name as a heading', async () => {
    const files = [new File(['Rule one text.'], 'house-rules.txt', { type: 'text/plain' }), new File(['## Weather\nIt rains.'], 'b.md')];
    const source = await importLibraryDocument({ title: '', format: 'text', files });
    expect(source.title).toBe('house-rules');
    expect(saved()[1].map((e) => e.name)).toEqual(['house-rules', 'Weather']);
  });

  it('imports JSON entries under new ids', async () => {
    const file = new File([JSON.stringify({ entries: [{ kind: 'spell', name: 'Frost Lance', text: 'Ice.' }] })], 'pack.json');
    const source = await importLibraryDocument({ title: 'Pack', format: 'json', files: [file] });
    expect(source.format).toBe('json');
    expect(saved()[1]).toEqual([{ id: `lib:${source.id}:1`, sourceId: source.id, sourceName: 'Pack', kind: 'spell', name: 'Frost Lance', text: 'Ice.' }]);
  });

  it("records that a JSON file's kinds are its own (one it leaves out is guessed now), and its book data says so", async () => {
    const wight = { kind: 'monster', name: 'Lamp Wight', text: 'Medium Undead, Neutral Evil\n\nArmor Class 13\nHit Points 22 (5d8)\nChallenge 1\n\nThe wight carries a lantern that never goes out.' };
    const lash = { name: 'Ember Lash', text: '| Casting Time | 1 action |\n|---|---|\n| Range | 60 feet |\n| Duration | Instantaneous |\n\nA lash of embers strikes one creature.' };
    const file = new File([JSON.stringify({ entries: [wight, lash] })], 'lamp.json');
    const source = await importLibraryDocument({ title: 'Lamp Bestiary', format: 'json', files: [file] });
    expect(source).toMatchObject({ format: 'json', kindsGuessed: false });
    // The file's own kind stays (today's rules would read this stat block, which has no XP, as a rule); the missing one is guessed.
    const [, entries] = saved();
    expect(entries.map((e) => [e.name, e.kind])).toEqual([['Lamp Wight', 'monster'], ['Ember Lash', 'spell']]);
    // Its book data says the kinds are the file's, so another device keeps them too.
    const data = JSON.parse(JSON.stringify(exportPack(source, entries, []))) as ReturnType<typeof exportPack>;
    expect(data).toMatchObject({ bookFingerprint: source.fingerprint, kindsGuessed: false });
    expect(parsePack(data, { sourceId: 'other', sourceName: 'Lamp Bestiary' }).entries.map((e) => e.kind)).toEqual(['monster', 'spell']);
    // Imported text records nothing: its kinds are guesses by its format.
    expect(await importLibraryDocument({ title: 'Notes', format: 'markdown', text: '# One\nFirst.' })).not.toHaveProperty('kindsGuessed');
  });

  it('extracts PDF text locally and reports page progress', async () => {
    vi.mocked(extractPdfMarkdown).mockImplementation(async (_file, opts) => {
      opts?.onPage?.(1, 2);
      opts?.onPage?.(2, 2);
      return '## Fireball\n_Level 3 Evocation (Wizard)_\n\nBoom.';
    });
    const progress: ImportProgress[] = [];
    const source = await importLibraryDocument(
      { title: 'Grimoire', format: 'pdf', files: [new File(['%PDF'], 'grimoire.pdf', { type: 'application/pdf' })] },
      (p) => progress.push(p),
    );
    expect(source.format).toBe('pdf');
    expect(saved()[1][0]).toMatchObject({ name: 'Fireball', kind: 'spell' });
    expect(progress[0]).toMatchObject({ stage: 'reading', done: 1, total: 2, message: 'Reading grimoire.pdf: page 1 of 2' });
    expect(transcribeImages).not.toHaveBeenCalled();
  });

  it('explains PDFs without a text layer', async () => {
    vi.mocked(extractPdfMarkdown).mockResolvedValue('');
    await expect(importLibraryDocument({ title: 'Scan', format: 'pdf', files: [new File(['%PDF'], 'scan.pdf')] })).rejects.toThrow(/no text layer/);
    expect(save).not.toHaveBeenCalled();
  });

  it('transcribes photos and keeps transcription warnings in the source notes', async () => {
    vi.mocked(transcribeImages).mockImplementation(async (_files, opts) => {
      opts?.onProgress?.(0, 1, 'Transcribing photo 1 of 1…');
      return { markdown: '## Owlbear\nA monstrous hybrid.', warnings: ['Photo 2 may be incomplete.'] };
    });
    const progress: ImportProgress[] = [];
    const photo = new File(['jpeg'], 'page.jpg', { type: 'image/jpeg' });
    const source = await importLibraryDocument({ title: 'Bestiary', format: 'image', files: [photo] }, (p) => progress.push(p));
    expect(vi.mocked(transcribeImages).mock.calls[0][0]).toEqual([photo]);
    expect(source).toMatchObject({ format: 'markdown', notes: 'Photo 2 may be incomplete.' });
    expect(progress[0]).toEqual({ stage: 'transcribing', done: 0, total: 1, message: 'Transcribing photo 1 of 1…' });
  });

  it('stops when cancelled and saves nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(importLibraryDocument({ title: 'X', format: 'markdown', text: '# A\nB' }, undefined, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects empty input and invalid JSON without saving', async () => {
    await expect(importLibraryDocument({ title: 'X', format: 'markdown', text: '   ' })).rejects.toThrow(/Paste some text/);
    await expect(importLibraryDocument({ title: 'X', format: 'json', text: '{' })).rejects.toThrow(/isn't valid JSON/);
    await expect(importLibraryDocument({ title: 'X', format: 'image', files: [new File(['x'], 'notes.txt')] })).rejects.toThrow(/photos/);
    expect(save).not.toHaveBeenCalled();
    expect(invalidateRulesIndex).not.toHaveBeenCalled();
  });

  it('stores the book’s fingerprint (entries as imported, in ordinal order) on the new source', async () => {
    const source = await importLibraryDocument({ title: 'Notes', format: 'markdown', text: '# One\nFirst.\n\n# Two\nSecond.' });
    const [, entries] = saved();
    expect(source.fingerprint).toBe(bookFingerprint(entries.map((e) => e.text)));
    expect(source.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('routes a Solo DM pack to the pack reader: entries and pending records saved together', async () => {
    const pack = exportPack(gloamwoodSource(), gloamwoodEntries(), gloamwoodRecords());
    const file = new File([JSON.stringify(pack)], 'gloamwood.book-data.json', { type: 'application/json' });
    const source = await importLibraryDocument({ title: '', format: 'json', files: [file] });
    expect(save).not.toHaveBeenCalled();
    const [savedSource, entries, records] = vi.mocked(saveLibrarySourceWithRecords).mock.calls[0];
    expect(savedSource).toBe(source);
    expect(source).toMatchObject({ title: 'The Gloamwood Almanac', format: 'json', kind: 'import', enabled: true, fingerprint: gloamwoodSource().fingerprint });
    expect(entries).toHaveLength(gloamwoodEntries().length);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.status === 'pending' && r.origin === 'pack' && r.sourceId === source.id)).toBe(true);
    expect(invalidateRulesIndex).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy JSON as it was and refuses a pack mixed with other files or a file over 20 MB', async () => {
    const pack = new File([JSON.stringify(exportPack(gloamwoodSource(), gloamwoodEntries(), []))], 'a.json');
    const legacy = new File([JSON.stringify([{ name: 'Rule', text: 'Text.' }])], 'b.json');
    await expect(importLibraryDocument({ title: 'Mixed', format: 'json', files: [pack, legacy] })).rejects.toThrow(/one Solo DM pack at a time/);
    const big = new File(['[]'], 'big.json');
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    await expect(importLibraryDocument({ title: 'Big', format: 'json', files: [big] })).rejects.toThrow(/larger than 20 MB/);
    expect(save).not.toHaveBeenCalled();
    expect(saveLibrarySourceWithRecords).not.toHaveBeenCalled();
  });
});
