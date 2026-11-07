import { useEffect, useLayoutEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, Download, ImageOff } from 'lucide-react';
import { useImageList, useImageUrl } from '@/storage';
import type { ImageSubject } from '@/types';
import { Button, Dialog, IconButton, Spinner } from '@/ui/components/ui';
import { imageFileName, SUBJECT_LABELS } from './imageInfo';

export interface LightboxImage {
  id: string;
  campaignId: string;
  title: string;
  subject: ImageSubject;
  /** The picture's type when the caller already knows it (gallery metadata); looked up otherwise. */
  mime?: string;
}

/** Previous / next for a set of pictures (the gallery). Wraps around at either end. */
export interface LightboxNavigation {
  /** 1-based. */
  position: number;
  count: number;
  onPrevious: () => void;
  onNext: () => void;
}

/** Same look as <Button variant="secondary"> (keep in sync with ui.tsx): a download is a link, not a button. */
const SAVE_LINK_CLASSES =
  'inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-border bg-surface-2 px-4 text-sm font-medium text-text transition-colors select-none hover:bg-surface-3';

/**
 * A picture at full size, with its title and a Save button (pictures live only in this browser, so
 * saving a copy is how the player keeps one). Open while `image` is set.
 */
export function ImageLightbox({
  image,
  onClose,
  navigation,
}: {
  image: LightboxImage | null;
  onClose: () => void;
  navigation?: LightboxNavigation;
}) {
  const url = useImageUrl(image?.id ?? null);
  // The type (for the file name) and whether this device has the picture at all.
  const known = useImageList(image && !image.mime ? image.campaignId : null);
  const meta = image && known?.find((m) => m.id === image.id);
  const mime = image?.mime ?? meta?.mime;
  const missing = Boolean(image && !image.mime && !url && known && !meta);
  useArrowKeys(image !== null ? navigation : undefined);

  const pager = navigation && navigation.count > 1 && (
    <div className="mr-auto flex items-center gap-1">
      <IconButton label="Previous picture" size="sm" onClick={navigation.onPrevious}>
        <ChevronLeft className="size-4" aria-hidden />
      </IconButton>
      <span className="min-w-12 text-center text-xs text-muted tabular-nums" aria-hidden>
        {navigation.position} of {navigation.count}
      </span>
      <IconButton label="Next picture" size="sm" onClick={navigation.onNext}>
        <ChevronRight className="size-4" aria-hidden />
      </IconButton>
    </div>
  );

  return (
    <Dialog
      open={image !== null}
      onClose={onClose}
      size="xl"
      title={image?.title ?? ''}
      description={image ? SUBJECT_LABELS[image.subject] : undefined}
      footer={
        <>
          {pager}
          {url && mime ? (
            <a href={url} download={imageFileName(image?.title ?? '', mime)} title="Save a copy to this device" className={SAVE_LINK_CLASSES}>
              <Download className="size-4" aria-hidden />
              Save
            </a>
          ) : (
            <Button disabled icon={<Download className="size-4" aria-hidden />}>
              Save
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      {image && (
        <div className="grid min-h-40 place-items-center">
          {url ? (
            <img src={url} alt={image.title} className="block h-auto max-h-[calc(85vh-11rem)] w-auto max-w-full rounded-xl" />
          ) : missing ? (
            <p className="flex items-center gap-2 text-sm text-muted">
              <ImageOff className="size-4 shrink-0" aria-hidden />
              This picture isn’t saved on this device.
            </p>
          ) : (
            <Spinner label="Loading the picture" />
          )}
        </div>
      )}
      {image && navigation && navigation.count > 1 && (
        <p className="sr-only" aria-live="polite">
          Picture {navigation.position} of {navigation.count}: {image.title}
        </p>
      )}
    </Dialog>
  );
}

/** Left / Right arrows step through the pictures while the lightbox is open. */
function useArrowKeys(navigation: LightboxNavigation | undefined): void {
  const latest = useRef(navigation);
  useLayoutEffect(() => {
    latest.current = navigation;
  });
  const active = navigation !== undefined && navigation.count > 1;
  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      const nav = latest.current;
      if (!nav || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === 'ArrowLeft') nav.onPrevious();
      else if (e.key === 'ArrowRight') nav.onNext();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active]);
}
