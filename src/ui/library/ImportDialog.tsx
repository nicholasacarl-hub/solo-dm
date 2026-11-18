/**
 * Import the player's own content into the library: paste text, upload a file (PDF with a text
 * layer, Markdown, plain text, JSON) or photograph pages (transcribed by Claude with the player's
 * API key). Shows progress from importLibraryDocument and can be cancelled.
 *
 * Paste with formatting: a copy from a web page or a document carries HTML beside its plain text; pasted with the
 * Markdown format chosen, its headings, tables and lists arrive as Markdown (src/data/htmlPaste.ts) on lines of their
 * own, undoable with Ctrl+Z (a long one, set directly, once), with a way back to the plain text.
 *
 * Structured imports (spec §4.1): once the import is saved, the dialog looks for spells, monsters and
 * character options on this device (detectStructure, dismissible: closing lets it finish) and ends on
 * a done page with what it found and a link to the book page. A JSON pack's records arrive pending
 * with one tap to accept the confident ones. In demo mode photos are refused (no API calls).
 */
import { useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { Camera, ClipboardType, FileUp, Info, Trash2, X } from 'lucide-react';
import {
  detectStructure,
  importLibraryDocument,
  type DetectionSummary,
  type ImportFormat,
  type ImportInput,
  type ImportProgress,
  type PackImport,
} from '@/data';
import { formattedPaste, type HtmlConversion } from '@/data/htmlPaste';
import { useSettings } from '@/state/settingsStore';
import { findSourcesByFingerprint, listRecords } from '@/storage';
import { MODELS, type LibrarySource } from '@/types';
import { Button, Dialog, Field, IconButton, Input, Textarea } from '@/ui/components/ui';
import { SegmentedField } from '@/ui/components/OptionCards';
import { ProgressBar } from '@/ui/components/ProgressBar';
import { toast } from '@/ui/components/toast';
import { errorMessage, formatBytes, formatUsd, isAbortError, plural } from '@/ui/shell/format';
import { refreshRulesIndex } from './kinds';
import { ImportDonePage } from './structure/ImportDonePage';
import { PRIVACY_PROMISES } from './structure/labels';
import { restoreLoadedCharacter } from './structure/reviewActions';

/** Photos are transcribed by Claude, so demo mode (no API calls) refuses them (spec §3.13). */
export const DEMO_PHOTOS = 'Demo mode makes no API calls. Turn it off in Settings to transcribe photos.';

interface Finished {
  source: LibrarySource;
  summary: DetectionSummary | null;
  pack: PackImport | null;
  detectError: string | null;
  duplicateOf: { id: string; title: string } | null;
}

/** A pack's records arrive with the import (they never go through detection). */
async function packImportOf(source: LibrarySource): Promise<PackImport | null> {
  const records = await listRecords(source.id);
  if (!records.some((r) => r.origin === 'pack')) return null;
  return {
    source: { title: source.title, license: source.license, attribution: source.attribution, notes: source.notes, fingerprint: source.fingerprint },
    entries: [],
    records,
    issues: [],
    reviewedElsewhere: records.filter((r) => r.reviewedElsewhere).length,
  };
}

async function sameBook(source: LibrarySource): Promise<{ id: string; title: string } | null> {
  if (!source.fingerprint) return null;
  const others = (await findSourcesByFingerprint(source.fingerprint)).filter((s) => s.id !== source.id);
  return others[0] ? { id: others[0].id, title: others[0].title } : null;
}

type Method = 'paste' | 'file' | 'photos';
type PasteFormat = 'markdown' | 'text' | 'json';

const MAX_PHOTOS = 40;
/** Rough per-photo token use when transcribing a dense page (for the cost note only). */
const PHOTO_TOKENS = { input: 1_600, output: 1_200 };

const FILE_FORMATS: Record<string, Exclude<ImportFormat, 'image'>> = {
  pdf: 'pdf',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  text: 'text',
  json: 'json',
};

/** The import format for an uploaded file, from its extension (or MIME type). */
export function formatForFile(file: File): Exclude<ImportFormat, 'image'> | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (FILE_FORMATS[ext]) return FILE_FORMATS[ext];
  if (file.type === 'application/pdf') return 'pdf';
  if (file.type === 'application/json') return 'json';
  if (file.type === 'text/markdown') return 'markdown';
  if (file.type.startsWith('text/')) return 'text';
  return null;
}

function titleFromFileName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
}

function progressText(p: ImportProgress): string {
  if (p.message) return p.message;
  switch (p.stage) {
    case 'reading':
      return p.total > 1 ? `Reading ${Math.min(p.done + 1, p.total)} of ${p.total}…` : 'Reading…';
    case 'transcribing':
      return `Transcribing page ${Math.min(p.done + 1, p.total)} of ${p.total}…`;
    case 'chunking':
      return 'Splitting into entries…';
    case 'saving':
      return 'Saving to this device…';
    case 'done':
      return 'Done.';
  }
}

const METHOD_OPTIONS = [
  { value: 'paste' as const, label: <><ClipboardType className="size-4" aria-hidden />Paste text</> },
  { value: 'file' as const, label: <><FileUp className="size-4" aria-hidden />Upload a file</> },
  { value: 'photos' as const, label: <><Camera className="size-4" aria-hidden />Photos</> },
];

const METHOD_HINTS: Record<Method, string> = {
  paste: 'Copy text from a digital book or your own notes.',
  file: 'A PDF with selectable text, or a Markdown, text or JSON file.',
  photos: 'Photograph printed pages; Claude transcribes them.',
};

/** What a formatted paste kept ("3 headings, 1 table and 2 lists"). */
function keptSummary(c: HtmlConversion): string {
  const parts = [
    c.headings ? plural(c.headings, 'heading') : '',
    c.tables ? plural(c.tables, 'table') : '',
    c.lists ? plural(c.lists, 'list') : '',
  ].filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
}

/** A formatted paste still in the text, which "Paste as plain text instead" swaps for the clipboard's plain text. */
interface FormattedPaste {
  start: number;
  markdown: string;
  plain: string;
  kept: string;
}

/**
 * The longest formatted paste (in lines) that goes through the browser's editing, so Ctrl+Z undoes it like any paste.
 * A longer one is set directly: the browser inserts it line by line, in time that grows with the square of its lines.
 */
const UNDOABLE_LINES = 200;
/** Each line it inserts also takes time that grows with the text in the box: lines × characters stay under this (about 0.15 s on a desktop). */
const UNDOABLE_COST = 200 * 50_000;

/** Line breaks that set pasted Markdown apart from the text before and after it, so its first heading starts a line. */
function apart(before: string, after: string): { lead: string; trail: string } {
  return {
    lead: !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n',
    trail: !after || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n',
  };
}

/** A caret set by script isn't scrolled to: a paste that ends the text shows that end, as the browser's own paste does. */
function revealEnd(box: HTMLTextAreaElement): void {
  if (box.selectionStart === box.value.length) box.scrollTop = box.scrollHeight;
}

const PASTE_FORMATS = [
  { value: 'markdown' as const, label: 'Markdown' },
  { value: 'text' as const, label: 'Plain text' },
  { value: 'json' as const, label: 'JSON' },
];

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const id = useId();
  const navigate = useNavigate();
  const { apiKey, model, mockMode } = useSettings(useShallow((s) => ({ apiKey: s.apiKey, model: s.model, mockMode: s.mockMode })));
  const [detecting, setDetecting] = useState<{ title: string; done: number; total: number } | null>(null);
  const [finished, setFinished] = useState<Finished | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const [method, setMethod] = useState<Method>('paste');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [text, setText] = useState('');
  const [pasteFormat, setPasteFormat] = useState<PasteFormat>('markdown');
  const [formatted, setFormatted] = useState<FormattedPaste | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // Where the caret goes once the text a paste set has rendered, and the view to keep (moving the box resets it).
  const caret = useRef<number | null>(null);
  const keptScroll = useRef<number | null>(null);
  // The text before and after the last paste set directly, which the browser can't undo: Ctrl+Z in the box puts it back.
  const directEdit = useRef<{ before: string; after: string; caret: number } | null>(null);
  useLayoutEffect(() => {
    const box = textRef.current;
    if (caret.current === null || !box) return;
    if (document.activeElement !== box) box.focus();
    box.setSelectionRange(caret.current, caret.current);
    if (keptScroll.current !== null) box.scrollTop = keptScroll.current;
    keptScroll.current = null;
    revealEnd(box);
    caret.current = null;
  }, [text]);

  /**
   * Put `insert` in place of the box's text from `start` to `end`, the caret at `caretAt`: through the browser's editing
   * when that's quick, so Ctrl+Z undoes it like any paste (its input event runs onChange), else by setting the text,
   * which Ctrl+Z in the box undoes once. Both read the box itself, whose line breaks are always \n.
   */
  const replaceInBox = (box: HTMLTextAreaElement, start: number, end: number, insert: string, caretAt: number) => {
    box.focus();
    box.setSelectionRange(start, end);
    const lines = insert.split('\n').length;
    const quick = lines <= UNDOABLE_LINES && lines * (box.value.length + insert.length) <= UNDOABLE_COST;
    if (quick && typeof document.execCommand === 'function' && document.execCommand('insertText', false, insert)) {
      box.setSelectionRange(caretAt, caretAt);
      revealEnd(box);
      return;
    }
    const next = box.value.slice(0, start) + insert + box.value.slice(end);
    if (next === box.value) {
      box.setSelectionRange(caretAt, caretAt);
      return;
    }
    // Chromium keeps the box's undo steps when its text is set by script, and Ctrl+Z or redo would replay them onto the
    // new text (an earlier paste glued to its end). Taking the box out of the page and back drops them; the caret effect
    // puts the focus and the view back.
    const { parentNode, nextSibling } = box;
    if (parentNode) {
      keptScroll.current = box.scrollTop;
      parentNode.removeChild(box);
      parentNode.insertBefore(box, nextSibling);
    }
    directEdit.current = { before: box.value, after: next, caret: end };
    caret.current = caretAt;
    setText(next);
  };

  /** A copy from a web page or a document: its HTML as Markdown, when the Markdown format is chosen and it has structure. */
  const pasteWithFormatting = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (pasteFormat !== 'markdown') return;
    const html = e.clipboardData.getData('text/html');
    if (!html) return;
    // Windows puts text on the clipboard with \r\n line breaks.
    const plain = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
    const conversion = formattedPaste(html, plain);
    if (!conversion) return;
    e.preventDefault();
    const box = e.currentTarget;
    const { selectionStart: start, selectionEnd: end, value } = box;
    const { lead, trail } = apart(value.slice(0, start), value.slice(end));
    const at = start + lead.length;
    replaceInBox(box, start, end, lead + conversion.markdown + trail, at + conversion.markdown.length);
    // After the insert: its input event clears what an earlier paste left.
    setFormatted({ start: at, markdown: conversion.markdown, plain, kept: keptSummary(conversion) });
  };

  /** Swap the formatted paste for the clipboard's plain text (only while the text still holds it as pasted). */
  const pasteAsPlainText = () => {
    const box = textRef.current;
    if (!formatted || !box) return;
    const { start, markdown, plain } = formatted;
    setFormatted(null);
    if (box.value.slice(start, start + markdown.length) !== markdown) return;
    replaceInBox(box, start, start + markdown.length, plain, start + plain.length);
  };
  const [file, setFile] = useState<File | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const controller = useRef<AbortController | null>(null);
  const running = progress !== null;

  const buildInput = (): ImportInput | string => {
    const name = title.trim();
    if (!name) return 'Give this import a title.';
    const base = { title: name, notes: notes.trim() || undefined };
    if (method === 'paste') {
      if (!text.trim()) return 'Paste some text to import.';
      return { ...base, format: pasteFormat, text };
    }
    if (method === 'file') {
      if (!file) return 'Choose a file to import.';
      const format = formatForFile(file);
      if (!format) return 'That file type isn’t supported. Use PDF, Markdown, plain text or JSON.';
      return { ...base, format, files: [file] };
    }
    if (mockMode) return DEMO_PHOTOS;
    if (!apiKey.trim()) return 'Transcribing photos needs your Anthropic API key. Add it in Settings first.';
    if (photos.length === 0) return 'Add at least one photo.';
    return { ...base, format: 'image', files: photos };
  };

  const run = async () => {
    const input = buildInput();
    if (typeof input === 'string') {
      setError(input);
      return;
    }
    setError(null);
    const abort = new AbortController();
    controller.current = abort;
    setProgress({ stage: 'reading', done: 0, total: 1 });
    let source: LibrarySource;
    try {
      source = await importLibraryDocument(input, setProgress, abort.signal);
      refreshRulesIndex();
      void restoreLoadedCharacter();
    } catch (err) {
      if (abort.signal.aborted || isAbortError(err)) toast.info('Import cancelled.');
      else setError(errorMessage(err, 'The import failed.'));
      return;
    } finally {
      controller.current = null;
      setProgress(null);
    }
    await structure(source);
  };

  /** After the import: look for structured entries on this device (closing the dialog lets it finish). */
  const structure = async (source: LibrarySource) => {
    const result: Finished = { source, summary: null, pack: null, detectError: null, duplicateOf: null };
    try {
      result.pack = await packImportOf(source);
      if (result.pack) {
        result.duplicateOf = await sameBook(source);
      } else {
        setDetecting({ title: source.title, done: 0, total: 1 });
        result.summary = await detectStructure(source.id, { onProgress: (done, total) => setDetecting({ title: source.title, done, total }) });
        refreshRulesIndex();
      }
    } catch (err) {
      result.detectError = errorMessage(err, 'something went wrong');
    } finally {
      setDetecting(null);
    }
    if (openRef.current) {
      setFinished(result);
      return;
    }
    // Closed while looking: say what was found.
    const found = result.summary?.total ?? result.pack?.records.length ?? 0;
    toast.success(
      found > 0
        ? `“${source.title}”: found ${found} ${found === 1 ? 'thing' : 'things'} to review. Open it from My library.`
        : `Imported “${source.title}”: ${plural(source.entryCount, 'entry', 'entries')}.`,
    );
  };

  const openBook = (source: LibrarySource) => {
    const needsClaude = (finished?.summary?.needClaude ?? 0) > 0;
    onClose();
    navigate(`/library/source/${encodeURIComponent(source.id)}${needsClaude ? '?setup=1' : ''}`);
  };

  const chooseFile = (picked: File | null) => {
    setFile(picked);
    setError(null);
    if (picked && !title.trim()) setTitle(titleFromFileName(picked.name));
  };

  const addPhotos = (picked: File[]) => {
    setPhotos((prev) => [...prev, ...picked.filter((f) => f.type.startsWith('image/'))].slice(0, MAX_PHOTOS));
    setError(null);
    if (picked.length > 0 && !title.trim()) setTitle('Photographed pages');
  };

  // The importer transcribes with the model chosen in Settings.
  const modelInfo = MODELS.find((m) => m.id === model) ?? MODELS[0];
  const perPage =
    (PHOTO_TOKENS.input * modelInfo.pricing.input + PHOTO_TOKENS.output * modelInfo.pricing.output) / 1_000_000;

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!running) onClose();
      }}
      dismissible={!running}
      size="lg"
      title={finished ? 'Imported' : 'Import into your library'}
      description={finished || detecting ? undefined : 'Rules from books you own become searchable for your DM.'}
      footer={
        finished ? undefined : running ? (
          <Button variant="ghost" icon={<X className="size-4" aria-hidden />} onClick={() => controller.current?.abort()}>
            Cancel import
          </Button>
        ) : detecting ? (
          <Button variant="ghost" onClick={onClose}>
            Close (it keeps looking)
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void run()}>
              Import
            </Button>
          </>
        )
      }
    >
      {finished ? (
        <ImportDonePage
          source={finished.source}
          summary={finished.summary}
          pack={finished.pack}
          detectError={finished.detectError}
          duplicateOf={finished.duplicateOf}
          onDone={onClose}
          onOpenBook={() => openBook(finished.source)}
        />
      ) : detecting ? (
        <div className="flex flex-col gap-3 py-6" role="status" aria-live="polite">
          <p className="text-sm font-medium">Looking for spells, monsters and character options…</p>
          <ProgressBar
            label="Looking through the book"
            value={detecting.done}
            max={Math.max(detecting.total, 1)}
            valueText={`${detecting.done} of ${detecting.total}`}
          />
          <p className="text-xs text-muted">This happens on this device, for free. You can close this; it keeps going.</p>
        </div>
      ) : running && progress ? (
        <div className="flex flex-col gap-3 py-6" role="status" aria-live="polite">
          <p className="text-sm font-medium">{progressText(progress)}</p>
          <ProgressBar
            label="Import progress"
            value={progress.stage === 'done' ? progress.total : progress.done}
            max={Math.max(progress.total, 1)}
            valueText={progressText(progress)}
          />
          <p className="text-xs text-muted">You can keep this open; large books take a minute.</p>
        </div>
      ) : (
        <form
          className="flex flex-col gap-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <Note>
            Imports stay on this device. Text goes to Anthropic, with your API key, only when you ask: photos to transcribe,
            entries to structure, and passages the DM looks up while you play. Save files and GitHub backups leave the book's
            text out. Only import content you own.
            <span className="mt-1.5 block">{PRIVACY_PROMISES.map((p) => p.title).join(' ')}</span>
          </Note>

          <SegmentedField
            legend="What are you importing?"
            hint={METHOD_HINTS[method]}
            stretch
            value={method}
            options={METHOD_OPTIONS}
            onChange={(m) => {
              setMethod(m);
              setError(null);
            }}
          />

          <Field label="Title" htmlFor={`${id}-title`} hint="How it appears in your library.">
            <Input
              id={`${id}-title`}
              value={title}
              maxLength={120}
              placeholder="e.g. My spell notes"
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>

          {method === 'paste' && (
            <>
              <Field
                label="Text"
                htmlFor={`${id}-text`}
                hint="Headings (like “## Fireball”) split the text into separate entries. A copy from a web page or a document keeps its headings, tables and lists."
              >
                <Textarea
                  id={`${id}-text`}
                  ref={textRef}
                  rows={9}
                  value={text}
                  onKeyDown={(e) => {
                    const edit = directEdit.current;
                    if (!edit || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
                    directEdit.current = null;
                    if (e.currentTarget.value !== edit.after) return;
                    e.preventDefault();
                    caret.current = edit.caret;
                    setText(edit.before);
                    setFormatted(null);
                  }}
                  onChange={(e) => {
                    directEdit.current = null;
                    caret.current = null;
                    setText(e.target.value);
                    setFormatted(null);
                  }}
                  onPaste={pasteWithFormatting}
                  placeholder={'## Lantern of Embers\nWondrous item, uncommon\n\nWhile lit, this lantern…'}
                  className="font-mono text-xs"
                />
                {/* The status stays mounted (hidden while empty) so screen readers announce a formatted paste. */}
                <div className={formatted ? 'flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted' : 'sr-only'}>
                  <p role="status" aria-live="polite">
                    {formatted ? `Pasted with formatting: kept ${formatted.kept}.` : ''}
                  </p>
                  {formatted?.plain && (
                    <Button variant="ghost" size="sm" onClick={pasteAsPlainText}>
                      Paste as plain text instead
                    </Button>
                  )}
                </div>
              </Field>
              <SegmentedField legend="Format" value={pasteFormat} options={PASTE_FORMATS} onChange={setPasteFormat} />
            </>
          )}

          {method === 'file' && (
            <FilePicker
              label="File"
              hint="One file per import. Scanned PDFs without selectable text work better as photos."
              accept=".pdf,.md,.markdown,.txt,.json,application/pdf,text/markdown,text/plain,application/json"
              onPick={(files) => chooseFile(files[0] ?? null)}
            >
              {file && (
                <ul>
                  <SelectedFile name={file.name} size={file.size} onRemove={() => setFile(null)} />
                </ul>
              )}
            </FilePicker>
          )}

          {method === 'photos' && (
            <>
              <FilePicker
                label="Photos"
                hint={`Clear, flat, well-lit photos work best. Up to ${MAX_PHOTOS} per import.`}
                accept="image/*"
                multiple
                onPick={addPhotos}
              >
                {photos.length > 0 && (
                  <ul aria-label={`${plural(photos.length, 'photo')} selected`} className="flex flex-col gap-1.5">
                    {photos.map((p, i) => (
                      <SelectedFile
                        key={`${p.name}-${i}`}
                        name={p.name}
                        size={p.size}
                        onRemove={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}
                      />
                    ))}
                  </ul>
                )}
              </FilePicker>
              {mockMode ? (
                <Note tone="warning">{DEMO_PHOTOS}</Note>
              ) : apiKey.trim() ? (
                <Note>
                  Photos are sent to Anthropic with your API key so Claude can transcribe them: roughly{' '}
                  {formatUsd(perPage)} per page with {modelInfo.label}
                  {photos.length > 1 ? `, about ${formatUsd(perPage * photos.length)} for these ${photos.length}` : ''}.
                  Dense pages cost more.
                </Note>
              ) : (
                <Note tone="warning">
                  Transcribing photos uses your Anthropic API key.{' '}
                  <Link to="/settings" className="font-medium text-accent underline underline-offset-2">
                    Add it in Settings
                  </Link>{' '}
                  first.
                </Note>
              )}
            </>
          )}

          <Field label="Notes (optional)" htmlFor={`${id}-notes`} hint="Where it’s from, which pages, anything to remember.">
            <Input id={`${id}-notes`} value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} />
          </Field>

          {error && (
            <p role="alert" className="rounded-xl bg-danger-soft/60 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}

function Note({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warning' }) {
  return (
    <div
      className={
        tone === 'warning'
          ? 'flex gap-2.5 rounded-xl bg-gold-soft/60 px-3 py-2.5 text-xs text-text'
          : 'flex gap-2.5 rounded-xl bg-surface-2 px-3 py-2.5 text-xs text-muted'
      }
    >
      <Info className={tone === 'warning' ? 'mt-0.5 size-3.5 shrink-0 text-gold' : 'mt-0.5 size-3.5 shrink-0 text-info'} aria-hidden />
      <p>{children}</p>
    </div>
  );
}

function FilePicker({
  label,
  hint,
  accept,
  multiple,
  onPick,
  children,
}: {
  label: string;
  hint: string;
  accept: string;
  multiple?: boolean;
  onPick: (files: File[]) => void;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium" id={`${id}-label`}>
        {label}
      </span>
      <label
        className="flex cursor-pointer flex-col items-center gap-1 rounded-xl border border-dashed border-border bg-surface-2/50 px-4 py-6 text-center transition-colors hover:border-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
      >
        <input
          type="file"
          accept={accept}
          multiple={multiple}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-hint`}
          className="sr-only"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) onPick(files);
          }}
        />
        <FileUp className="size-5 text-muted" aria-hidden />
        <span className="text-sm font-medium">{multiple ? 'Choose photos' : 'Choose a file'}</span>
        <span id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </span>
      </label>
      {children}
    </div>
  );
}

function SelectedFile({ name, size, onRemove }: { name: string; size: number; onRemove: () => void }) {
  return (
    <li className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm">
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="shrink-0 text-xs text-muted">{formatBytes(size)}</span>
      <IconButton label={`Remove ${name}`} size="sm" onClick={onRemove}>
        <Trash2 className="size-4" aria-hidden />
      </IconButton>
    </li>
  );
}
