/**
 * Book-level controls shared by the book page and My library (spec D41, §4.7, §4.10): switching a book
 * off or deleting it says who uses it ("Used by Ember (The Drowned Lantern): …") and tells the DMs
 * of campaigns in session; switching it on refreshes the index and restores book text onto the loaded
 * hero; and the "How your book stays private" popover with the three promises.
 */
import { useEffect, useState } from 'react';
import { ShieldCheck, Users } from 'lucide-react';
import { charactersUsingSource, deleteLibrarySource, setLibrarySourceEnabled } from '@/storage';
import type { LibrarySource } from '@/types';
import { toast } from '@/ui/components/toast';
import { Button, Dialog } from '@/ui/components/ui';
import { Popover } from '@/ui/play/components/Popover';
import { errorMessage, plural } from '@/ui/shell/format';
import { refreshRulesIndex } from '../kinds';
import { PRIVACY_PROMISES } from './labels';
import { TOUCH, TOUCH_FOOTER } from './touch';
import { bookGoneNotice, restoreLoadedCharacter, tellDmsInSession } from './reviewActions';

type User = { campaignId: string; campaignName: string; characterName: string };

/** "Ember (The Drowned Lantern) and Mira (Salt Roads)". */
export function usedByText(users: readonly User[]): string {
  const names = users.map((u) => `${u.characterName} (${u.campaignName})`);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function useCharactersUsing(sourceId: string | null): User[] | null {
  const [users, setUsers] = useState<User[] | null>(null);
  useEffect(() => {
    if (!sourceId) return;
    let alive = true;
    charactersUsingSource(sourceId).then(
      (u) => alive && setUsers(u),
      () => alive && setUsers([]),
    );
    return () => {
      alive = false;
      setUsers(null);
    };
  }, [sourceId]);
  return users;
}

/** "Used by Ember (The Drowned Lantern): the sheet keeps its text; level-up and combat lose this book's data until it's back." */
export function UsedByNotice({ sourceId }: { sourceId: string }) {
  const users = useCharactersUsing(sourceId);
  if (!users || users.length === 0) return null;
  return (
    <p className="mt-3 flex gap-2 rounded-xl bg-gold-soft/60 px-3 py-2 text-sm">
      <Users className="mt-0.5 size-4 shrink-0 text-gold" aria-hidden />
      <span>
        Used by {usedByText(users)}: the sheet keeps its text; level-up and combat lose this book's data until it's back.
      </span>
    </p>
  );
}

async function switchBook(source: LibrarySource, enabled: boolean): Promise<void> {
  await setLibrarySourceEnabled(source.id, enabled);
  refreshRulesIndex();
  if (enabled) await restoreLoadedCharacter();
  else await tellDmsInSession(bookGoneNotice(source, 'off'));
}

/** The book's switch: on at once; off after a confirm when a character uses it. */
export function useBookSwitch(): { toggle(source: LibrarySource, enabled: boolean): void; dialog: React.ReactNode } {
  const [pending, setPending] = useState<LibrarySource | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (source: LibrarySource, enabled: boolean) => {
    try {
      await switchBook(source, enabled);
    } catch (error) {
      toast.error(errorMessage(error, 'Could not update that book.'));
    }
  };
  const toggle = (source: LibrarySource, enabled: boolean) => {
    if (enabled) {
      void run(source, true);
      return;
    }
    void charactersUsingSource(source.id).then(
      (users) => (users.length > 0 ? setPending(source) : void run(source, false)),
      () => void run(source, false),
    );
  };
  const dialog = (
    <Dialog
      open={pending !== null}
      onClose={() => !busy && setPending(null)}
      size="sm"
      title="Switch this book off?"
      footer={
        <div className={TOUCH_FOOTER}>
          <Button variant="ghost" disabled={busy} onClick={() => setPending(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              const source = pending;
              if (!source) return;
              setBusy(true);
              void run(source, false).finally(() => {
                setBusy(false);
                setPending(null);
              });
            }}
          >
            Switch off
          </Button>
        </div>
      }
    >
      {pending && (
        <>
          <p className="text-sm">The DM stops searching “{pending.title}”, and its accepted entries aren't used anywhere until you switch it back on.</p>
          <UsedByNotice sourceId={pending.id} />
        </>
      )}
    </Dialog>
  );
  return { toggle, dialog };
}

export function DeleteBookDialog({ source, onClose, onDeleted }: { source: LibrarySource | null; onClose(): void; onDeleted?(): void }) {
  const [deleting, setDeleting] = useState(false);
  const confirm = async () => {
    if (!source) return;
    setDeleting(true);
    try {
      await deleteLibrarySource(source.id);
      refreshRulesIndex();
      toast.success(`Deleted “${source.title}”.`);
      onClose();
      onDeleted?.();
      void tellDmsInSession(bookGoneNotice(source, 'deleted'));
    } catch (error) {
      toast.error(errorMessage(error, 'Could not delete that book.'));
    } finally {
      setDeleting(false);
    }
  };
  return (
    <Dialog
      open={source !== null}
      onClose={() => {
        if (!deleting) onClose();
      }}
      size="sm"
      title="Delete this import?"
      footer={
        <div className={TOUCH_FOOTER}>
          <Button variant="ghost" disabled={deleting} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={deleting} onClick={() => void confirm()}>
            Delete
          </Button>
        </div>
      }
    >
      {source && (
        <>
          <p className="text-sm">
            “{source.title}” and its {plural(source.entryCount, 'entry', 'entries')} will be removed from this browser, with everything structured
            from it. Your campaigns keep any homebrew based on it.
          </p>
          <UsedByNotice sourceId={source.id} />
        </>
      )}
    </Dialog>
  );
}

/** "How your book stays private": the three promises in full. */
export function PrivacyPopover() {
  return (
    <Popover
      label="How your book stays private"
      placement="bottom-end"
      className="w-[min(22rem,calc(100vw-2rem))]"
      trigger={(t) => (
        <button {...t} type="button" className={`inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-info hover:bg-surface-2 ${TOUCH}`}>
          <ShieldCheck className="size-3.5" aria-hidden />
          Privacy
        </button>
      )}
    >
      <h3 className="mb-2 text-sm font-semibold">How your book stays private</h3>
      <ol className="flex flex-col gap-2 text-xs">
        {PRIVACY_PROMISES.map((p) => (
          <li key={p.title}>
            <p className="font-medium text-text">{p.title}</p>
            <p className="mt-0.5 text-muted">{p.body}</p>
          </li>
        ))}
      </ol>
    </Popover>
  );
}
