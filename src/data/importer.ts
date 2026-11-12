/**
 * The import pipeline: the player's own books and notes become a library source in this browser.
 * Text, Markdown, JSON and PDF are processed locally; photos are transcribed by Claude with the
 * player's API key (the only time imported content leaves the device, and only when the player
 * imports photos).
 */
import type { CompendiumEntry, LibrarySource } from '@/types';
import { newId } from '@/lib/id';
import { bookFingerprint } from '@/lib/importedContent';
import { saveLibrarySource, saveLibrarySourceWithRecords } from '@/storage';
import { chunkDocument } from './chunk';
import { routeJsonImport } from './jsonImport';
import { invalidateRulesIndex } from './rulesIndexStore';
import type { PackImport } from './structured/packs';
import { STRUCTURED_LIMITS } from './structured/schemas';
import { throwIfAborted } from './text';
import type { ImportInput, ImportProgress } from './index';

type Report = (p: ImportProgress) => void;

const fileTitle = (file: File) => file.name.replace(/\.[^.]+$/, '').trim() || file.name;

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function isImage(file: File): boolean {
  return file.type.startsWith('image/') || /\.(?:jpe?g|png|gif|webp|heic|heif|avif|bmp)$/i.test(file.name);
}

/**
 * Pasted text plus the text of each file. With several Markdown/text files, a file that doesn't
 * start with a heading gets its file name as one, so its entries stay grouped.
 */
async function readTexts(input: ImportInput, report: Report, signal?: AbortSignal, { headings = true } = {}): Promise<string[]> {
  const files = input.files ?? [];
  const texts: string[] = [];
  if (input.text?.trim()) texts.push(input.text);
  for (const [i, file] of files.entries()) {
    throwIfAborted(signal);
    report({ stage: 'reading', done: i, total: files.length, message: `Reading ${file.name}…` });
    const text = await file.text();
    const headed = headings && files.length > 1 && !/^\s*#{1,6}\s/.test(text) ? `# ${fileTitle(file)}\n\n${text}` : text;
    if (headed.trim()) texts.push(headed);
  }
  return texts;
}

async function readPdfs(files: File[], report: Report, signal?: AbortSignal): Promise<string> {
  const pdfs = files.filter(isPdf);
  if (!pdfs.length) throw new Error('Choose a PDF file to import.');
  const { extractPdfMarkdown } = await import('./pdf');
  const parts: string[] = [];
  for (const [i, file] of pdfs.entries()) {
    const markdown = await extractPdfMarkdown(file, {
      signal,
      onPage: (done, total) =>
        report({ stage: 'reading', done, total, message: `Reading ${file.name}: page ${done} of ${total}${pdfs.length > 1 ? ` (file ${i + 1} of ${pdfs.length})` : ''}` }),
    });
    if (markdown.trim()) parts.push(pdfs.length > 1 && !/^#\s/.test(markdown) ? `# ${fileTitle(file)}\n\n${markdown}` : markdown);
  }
  if (!parts.length) {
    throw new Error("This PDF has no text layer (it's probably a scan). Import photos of the pages instead.");
  }
  return parts.join('\n\n');
}

async function transcribePhotos(files: File[], report: Report, signal?: AbortSignal): Promise<{ markdown: string; warnings: string[] }> {
  const photos = files.filter(isImage);
  if (!photos.length) throw new Error('Choose one or more photos of book pages to import.');
  const { transcribeImages } = await import('./vision');
  return transcribeImages(photos, {
    signal,
    onProgress: (done, total, message) => report({ stage: 'transcribing', done, total, message }),
  });
}

function defaultTitle(input: ImportInput): string {
  const title = input.title.trim();
  if (title) return title;
  const first = input.files?.[0];
  return first ? fileTitle(first) : 'Imported notes';
}

/** Extract text, split it into entries and save them as a new, enabled library source. */
export async function importLibraryDocument(
  input: ImportInput,
  onProgress?: (p: ImportProgress) => void,
  signal?: AbortSignal,
): Promise<LibrarySource> {
  const report: Report = (p) => onProgress?.(p);
  throwIfAborted(signal);
  const title = defaultTitle(input);
  const sourceId = `import-${newId().replace(/-/g, '').slice(0, 12)}`;
  const opts = { sourceId, sourceName: title };
  const notes = input.notes?.trim() ? [input.notes.trim()] : [];
  const files = input.files ?? [];
  let entries: CompendiumEntry[];
  let format: NonNullable<LibrarySource['format']>;

  if (input.format === 'json') {
    const tooLarge = files.find((f) => f.size > STRUCTURED_LIMITS.pack.bytes);
    if (tooLarge) throw new Error(`${tooLarge.name} is larger than ${STRUCTURED_LIMITS.pack.bytes / 1024 / 1024} MB, the most Solo DM imports from one JSON file.`);
    const texts = await readTexts(input, report, signal, { headings: false });
    if (!texts.length) throw new Error('Paste JSON or choose a .json file to import.');
    report({ stage: 'chunking', done: 0, total: 1, message: 'Checking entries…' });
    const routed = texts.map((text) => routeJsonImport(text, opts));
    const pack = routed.find((r) => r.type === 'pack');
    if (pack) {
      if (routed.length > 1) throw new Error('Import one Solo DM pack at a time, on its own.');
      return savePack(pack.pack, { sourceId, title: input.title.trim(), notes, report });
    }
    entries = routed.flatMap((r) => (r.type === 'entries' ? r.entries : []));
    entries = entries.map((e, i) => ({ ...e, id: `lib:${sourceId}:${i + 1}` }));
    format = 'json';
  } else {
    let text: string;
    if (input.format === 'pdf') {
      text = await readPdfs(files, report, signal);
      format = 'pdf';
    } else if (input.format === 'image') {
      const result = await transcribePhotos(files, report, signal);
      text = result.markdown;
      notes.push(...result.warnings);
      format = 'markdown';
    } else {
      const texts = await readTexts(input, report, signal);
      if (!texts.length) throw new Error('Paste some text or choose a file to import.');
      text = texts.join('\n\n');
      format = input.format;
    }
    throwIfAborted(signal);
    report({ stage: 'chunking', done: 0, total: 1, message: 'Splitting into entries…' });
    entries = chunkDocument(text, opts);
  }
  if (!entries.length) throw new Error('Nothing to import: no text was found.');
  throwIfAborted(signal);

  report({ stage: 'saving', done: 0, total: 1, message: `Saving ${entries.length} entries…` });
  const now = Date.now();
  const source: LibrarySource = {
    id: sourceId,
    title,
    kind: 'import',
    format,
    enabled: true,
    entryCount: entries.length,
    ...(notes.length ? { notes: notes.join('\n') } : {}),
    createdAt: now,
    updatedAt: now,
    // The book's identity (spec D7): restores copied text on another device that imports the same book.
    fingerprint: bookFingerprint(entries.map((e) => e.text)),
    // A JSON file's kinds are its own (one it left out was guessed just now, by today's rules): never corrected, here or on another device.
    ...(format === 'json' ? { kindsGuessed: false } : {}),
  };
  await saveLibrarySource(source, entries);
  invalidateRulesIndex();
  report({ stage: 'done', done: 1, total: 1, message: `Imported ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}.` });
  return source;
}

/**
 * A Solo DM pack (spec §3.12): its entries and records in one transaction (records arrive pending; a
 * "Download book data" file's records accepted on the other device are only offered, never applied).
 */
async function savePack(
  pack: PackImport,
  opts: { sourceId: string; title: string; notes: string[]; report: Report },
): Promise<LibrarySource> {
  if (!pack.entries.length) throw new Error('Nothing to import: the pack has no entries.');
  opts.report({ stage: 'saving', done: 0, total: 1, message: `Saving ${pack.entries.length} entries and ${pack.records.length} structured records…` });
  const now = Date.now();
  const notes = [...opts.notes, pack.source.notes].filter(Boolean).join('\n');
  const source: LibrarySource = {
    id: opts.sourceId,
    title: opts.title || pack.source.title,
    kind: 'import',
    format: 'json',
    enabled: true,
    entryCount: pack.entries.length,
    ...(pack.source.license ? { license: pack.source.license } : {}),
    ...(pack.source.attribution ? { attribution: pack.source.attribution } : {}),
    ...(notes ? { notes } : {}),
    ...(pack.source.fingerprint ? { fingerprint: pack.source.fingerprint } : {}),
    ...(pack.source.kindsGuessed !== undefined ? { kindsGuessed: pack.source.kindsGuessed } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await saveLibrarySourceWithRecords(source, pack.entries, pack.records);
  invalidateRulesIndex();
  opts.report({ stage: 'done', done: 1, total: 1, message: `Imported ${pack.entries.length} ${pack.entries.length === 1 ? 'entry' : 'entries'}.` });
  return source;
}
