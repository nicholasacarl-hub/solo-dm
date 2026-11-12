/**
 * The book page's header (spec §4.4): back to the Library, the title, the "Use in rules search" switch,
 * "Read the rest with Claude…", the ⋯ menu (look again, Download book data, delete; "Re-check for free" is the banner's),
 * and the counts line with the privacy popover.
 */
import { Link } from 'react-router';
import { ArrowLeft, Download, MoreHorizontal, ScanSearch, Sparkles, Trash2 } from 'lucide-react';
import type { LibrarySource } from '@/types';
import { Button, IconButton, Switch } from '@/ui/components/ui';
import { Menu, type MenuItem } from '@/ui/play/components/Menu';
import { plural } from '@/ui/shell/format';
import type { ReviewCounts } from './bookData';
import { PrivacyPopover } from './bookControls';
import { TOUCH, TOUCH_SQUARE, TOUCH_SWITCH } from './touch';

const FORMAT_LABELS: Record<NonNullable<LibrarySource['format']>, string> = { text: 'Plain text', markdown: 'Markdown', pdf: 'PDF', json: 'JSON' };

/** "508 found: 94 in use · 196 to review · 19 need a fix · 136 not read yet". */
export function countsLine(counts: ReviewCounts): string {
  const parts = [
    counts.used ? `${counts.used} in use` : null,
    counts.review ? `${counts.review} to review` : null,
    counts.fix ? `${counts.fix} ${counts.fix === 1 ? 'needs' : 'need'} a fix` : null,
    counts.failed ? `${counts.failed} couldn't be read` : null,
    counts.unread ? `${counts.unread} not read yet` : null,
    counts.text ? `${counts.text} kept as text` : null,
  ].filter(Boolean);
  return `${counts.all} found${parts.length ? `: ${parts.join(' · ')}` : ''}`;
}

/** The id of the book's title (a focus target that stays on the page). */
export const BOOK_TITLE_ID = 'book-title';

export function BookHeader({
  source,
  counts,
  structured,
  unread,
  detecting,
  onToggle,
  onRead,
  onDetect,
  onDownloadBookData,
  onDelete,
}: {
  source: LibrarySource;
  counts: ReviewCounts;
  /** Detection has run for this book. */
  structured: boolean;
  /** Records the offline reader couldn't read. */
  unread: number;
  detecting: boolean;
  onToggle(enabled: boolean): void;
  onRead(): void;
  onDetect(): void;
  onDownloadBookData(): void;
  onDelete(): void;
}) {
  const menu: MenuItem[] = [
    { id: 'detect', label: structured ? 'Look for entries again' : 'Structure this book', icon: <ScanSearch className="size-4" aria-hidden />, onSelect: onDetect, disabled: detecting },
    { id: 'data', label: "Download book data (contains the book's text)", icon: <Download className="size-4" aria-hidden />, onSelect: onDownloadBookData },
    { id: 'delete', label: 'Delete this book', icon: <Trash2 className="size-4" aria-hidden />, onSelect: onDelete },
  ];
  const meta = [plural(source.entryCount, 'entry', 'entries'), source.format ? FORMAT_LABELS[source.format] : null, structured ? countsLine(counts) : 'Not structured yet'].filter(Boolean);
  return (
    <header className="mb-4 flex flex-col gap-2">
      <Link to="/library?tab=mine" className={`inline-flex w-fit items-center gap-1 rounded-lg py-1 text-sm text-muted hover:text-text ${TOUCH}`}>
        <ArrowLeft className="size-4" aria-hidden />
        Library
      </Link>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* Leaves room for the ⋯ button (44 px on touch screens) and the gap on the title's line. */}
        {/* Focusable by script: where focus goes when the control that had it goes away (BOOK_TITLE_ID). */}
        <h1
          id={BOOK_TITLE_ID}
          tabIndex={-1}
          className="order-1 w-[calc(100%-3.5rem)] min-w-0 font-display text-2xl font-semibold tracking-wide outline-none [overflow-wrap:anywhere] sm:text-[1.75rem] lg:w-auto lg:flex-1"
        >
          {source.title}
        </h1>
        <div className="order-2 lg:order-5">
          <Menu
            label="Book actions"
            items={menu}
            trigger={(t) => (
              <IconButton {...t} label="Book actions" className={TOUCH_SQUARE}>
                <MoreHorizontal className="size-5" aria-hidden />
              </IconButton>
            )}
          />
        </div>
        <div className={`order-3 w-56 ${TOUCH_SWITCH}`}>
          <Switch checked={source.enabled} onChange={onToggle} label="Use in rules search" />
        </div>
        {unread > 0 && (
          <Button className={`order-4 ${TOUCH}`} variant="primary" icon={<Sparkles className="size-4" aria-hidden />} onClick={onRead}>
            Read the rest with Claude…
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">{meta.join(' · ')}</p>
        <PrivacyPopover />
      </div>
    </header>
  );
}
