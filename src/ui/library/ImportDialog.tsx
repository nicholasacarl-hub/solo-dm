/**
 * Import the player's own content into the library: paste text, upload a file (PDF with a text
 * layer, Markdown, plain text, JSON) or photograph pages (transcribed by Claude with the player's
 * API key). Shows progress from importLibraryDocument and can be cancelled.
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { Camera, ClipboardType, FileUp, Info, Trash2, X } from 'lucide-react';
import { importLibraryDocument, type ImportFormat, type ImportInput, type ImportProgress } from '@/data';
import { useSettings } from '@/state/settingsStore';
import { MODELS } from '@/types';
import { Button, Dialog, Field, IconButton, Input, Textarea } from '@/ui/components/ui';
import { SegmentedField } from '@/ui/components/OptionCards';
import { ProgressBar } from '@/ui/components/ProgressBar';
import { toast } from '@/ui/components/toast';
import { errorMessage, formatBytes, formatUsd, isAbortError, plural } from '@/ui/shell/format';
import { refreshRulesIndex } from './kinds';

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

const PASTE_FORMATS = [
  { value: 'markdown' as const, label: 'Markdown' },
  { value: 'text' as const, label: 'Plain text' },
  { value: 'json' as const, label: 'JSON' },
];

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const id = useId();
  const { apiKey, model } = useSettings(useShallow((s) => ({ apiKey: s.apiKey, model: s.model })));
  const [method, setMethod] = useState<Method>('paste');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [text, setText] = useState('');
  const [pasteFormat, setPasteFormat] = useState<PasteFormat>('markdown');
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
    try {
      const source = await importLibraryDocument(input, setProgress, abort.signal);
      refreshRulesIndex();
      toast.success(`Imported “${source.title}”: ${plural(source.entryCount, 'entry', 'entries')}.`);
      onClose();
    } catch (err) {
      if (abort.signal.aborted || isAbortError(err)) toast.info('Import cancelled.');
      else setError(errorMessage(err, 'The import failed.'));
    } finally {
      controller.current = null;
      setProgress(null);
    }
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
      title="Import into your library"
      description="Rules from books you own become searchable for your DM."
      footer={
        running ? (
          <Button variant="ghost" icon={<X className="size-4" aria-hidden />} onClick={() => controller.current?.abort()}>
            Cancel import
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
      {running && progress ? (
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
            Imports stay on this device and are left out of exported save files. Only import content you own, such as
            books you’ve bought or your own notes.
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
                hint="Headings (like “## Fireball”) split the text into separate entries."
              >
                <Textarea
                  id={`${id}-text`}
                  rows={9}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={'## Lantern of Embers\nWondrous item, uncommon\n\nWhile lit, this lantern…'}
                  className="font-mono text-xs"
                />
              </Field>
              <SegmentedField legend="Format" value={pasteFormat} options={PASTE_FORMATS} onChange={setPasteFormat} />
            </>
          )}

          {method === 'file' && (
            <FilePicker
              label="File"
              hint="PDF with selectable text, Markdown (.md), plain text (.txt) or JSON."
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
              {apiKey.trim() ? (
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
