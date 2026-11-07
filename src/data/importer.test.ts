import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompendiumEntry, LibrarySource } from '@/types';

vi.mock('@/storage', () => ({ saveLibrarySource: vi.fn(async () => {}) }));
vi.mock('./rulesIndexStore', () => ({ invalidateRulesIndex: vi.fn() }));
vi.mock('./pdf', () => ({ extractPdfMarkdown: vi.fn() }));
vi.mock('./vision', () => ({ transcribeImages: vi.fn() }));

import { saveLibrarySource } from '@/storage';
import { importLibraryDocument } from './importer';
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
});
