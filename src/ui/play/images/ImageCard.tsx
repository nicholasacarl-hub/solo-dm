import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Expand, ImageOff, Paintbrush, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/cn';
import { usePicture, type PictureView } from '@/images';
import type { ImageLogEntry, ImageSubject } from '@/types';
import { toast } from '@/ui/components/toast';
import { errorMessage } from '../format';
import { FRAME_CLASSES, PICTURE_MAX_HEIGHT, shapeForSubject, SUBJECT_LABELS } from './imageInfo';
import { ImageLightbox } from './ImageLightbox';

/**
 * An illustration in the story: a calm "Painting…" placeholder while it is made, then the picture
 * (tap to see it larger and save it), or a quiet note when there is none.
 */
export function ImageCard({ entry }: { entry: ImageLogEntry }) {
  const view = usePicture(entry);
  switch (view.status) {
    case 'ready':
      return <ReadyImage entry={entry} url={view.url} />;
    case 'painting':
    case 'loading':
      return <PlaceholderImage entry={entry} painting={view.status === 'painting'} />;
    case 'failed':
      return <FailedImage title={entry.title} view={view} />;
    case 'interrupted':
      return <ImageNote>{`“${entry.title}” was interrupted before it was finished. Ask the DM to paint it again.`}</ImageNote>;
    case 'missing':
      return <ImageNote>{`“${entry.title}” isn’t on this device. Pictures stay in the browser they were painted in.`}</ImageNote>;
  }
}

/** A small muted line, like a tool line: a missing picture isn't worth an alarm in the middle of the story. */
function ImageNote({ children, action }: { children: string; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 text-sm">
      <ImageOff className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden />
      <p className="min-w-0 text-muted">
        {children}
        {action}
      </p>
    </div>
  );
}

function FailedImage({ title, view }: { title: string; view: Extract<PictureView, { status: 'failed' }> }) {
  const [retrying, setRetrying] = useState(false);
  const retry = view.retry;
  const onRetry = async () => {
    if (!retry) return;
    setRetrying(true);
    try {
      await retry();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRetrying(false);
    }
  };
  return (
    <ImageNote
      action={
        retry && (
          <button
            type="button"
            onClick={() => void onRetry()}
            disabled={retrying}
            className="ml-1.5 inline-flex items-center gap-1 rounded-md px-1 align-baseline text-xs font-medium text-muted underline-offset-2 hover:text-text hover:underline disabled:opacity-60"
          >
            <RotateCcw className="size-3" aria-hidden />
            Try again
          </button>
        )
      }
    >
      {`Couldn’t paint “${title}”. ${view.error.trim()}`.trim()}
    </ImageNote>
  );
}

function Caption({ title, subject, titleId }: { title: string; subject: ImageSubject; titleId: string }) {
  return (
    <figcaption className="flex items-baseline gap-3 border-t border-border px-4 py-2.5">
      <span id={titleId} className="min-w-0 flex-1 text-sm font-medium text-text">
        {title}
      </span>
      <span className="shrink-0 text-[0.6875rem] font-semibold tracking-wider text-faint uppercase">{SUBJECT_LABELS[subject]}</span>
    </figcaption>
  );
}

const CARD = 'overflow-hidden rounded-2xl border border-border bg-surface shadow-card';

/** While it's painted ("Painting…"), or read from this device (an empty frame for a moment). */
function PlaceholderImage({ entry, painting }: { entry: ImageLogEntry; painting: boolean }) {
  const titleId = useId();
  return (
    <figure className={CARD} aria-busy="true" aria-labelledby={titleId}>
      <div className="bg-surface-2">
        <div className={cn('grid place-items-center', FRAME_CLASSES[shapeForSubject(entry.subject)])}>
          {painting && (
            <span className="flex flex-col items-center gap-2 text-muted motion-safe:animate-pulse">
              <Paintbrush className="size-6" aria-hidden />
              <span className="text-sm">Painting…</span>
            </span>
          )}
        </div>
      </div>
      <Caption title={entry.title} subject={entry.subject} titleId={titleId} />
    </figure>
  );
}

/**
 * Whether the picture has its size yet. Until then the frame keeps its place: an image with no size
 * would shrink the story for a moment, and the log would lose its hold on the latest line.
 */
function useDecoded(url: string) {
  const ref = useRef<HTMLImageElement>(null);
  const [decoded, setDecoded] = useState<{ url: string; ok: boolean } | null>(null);
  // A picture already in the cache can be complete before React attaches onLoad.
  useLayoutEffect(() => {
    const img = ref.current;
    if (img?.complete && img.naturalWidth > 0) setDecoded({ url, ok: true });
  }, [url]);
  const state = decoded?.url === url ? (decoded.ok ? 'ready' : 'broken') : 'decoding';
  return {
    ref,
    state,
    onLoad: () => setDecoded({ url, ok: true }),
    onError: () => setDecoded({ url, ok: false }),
  } as const;
}

function ReadyImage({ entry, url }: { entry: ImageLogEntry; url: string }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const { ref, state, onLoad, onError } = useDecoded(url);
  if (state === 'broken') return <ImageNote>{`This browser can’t show “${entry.title}”.`}</ImageNote>;
  const decoding = state === 'decoding';
  return (
    <>
      <figure className={CARD} aria-labelledby={titleId}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Open picture: ${entry.title}`}
          title="See it larger"
          className="group relative block w-full bg-surface-2 focus-visible:outline-offset-[-3px]"
        >
          {decoding && <div className={FRAME_CLASSES[shapeForSubject(entry.subject)]} />}
          <img
            ref={ref}
            src={url}
            alt={entry.title}
            onLoad={onLoad}
            onError={onError}
            className={cn(
              'mx-auto block h-auto w-auto max-w-full',
              PICTURE_MAX_HEIGHT,
              decoding && 'absolute inset-0 opacity-0',
            )}
          />
          <span
            aria-hidden
            className="absolute top-2 right-2 grid size-8 place-items-center rounded-lg border border-border bg-surface/85 text-text opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            <Expand className="size-4" />
          </span>
        </button>
        <Caption title={entry.title} subject={entry.subject} titleId={titleId} />
      </figure>
      <ImageLightbox
        image={open ? { id: entry.imageId, campaignId: entry.campaignId, title: entry.title, subject: entry.subject } : null}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
