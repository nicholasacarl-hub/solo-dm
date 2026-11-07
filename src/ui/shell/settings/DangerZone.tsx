/** Settings: reset settings, or wipe every bit of Solo DM data from this browser. */
import { useId, useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useSettings } from '@/state/settingsStore';
import { Button, Dialog, Field, Input } from '@/ui/components/ui';
import { toast } from '@/ui/components/toast';
import { errorMessage } from '../format';

const DATABASE_NAME = 'solo-dm';
const STORAGE_PREFIX = 'solo-dm:';
const CONFIRM_WORD = 'DELETE';

function clearPrefixedKeys(storage: Storage | undefined): void {
  if (!storage) return;
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

function safeStorage(kind: 'local' | 'session'): Storage | undefined {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Delete the IndexedDB database and every 'solo-dm:*' key. Resolves once the database is gone;
 * `onBlocked` fires if another tab still holds it open (deletion completes when that tab closes).
 */
export function deleteAllLocalData(onBlocked?: () => void): Promise<void> {
  clearPrefixedKeys(safeStorage('local'));
  clearPrefixedKeys(safeStorage('session'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('The browser refused to delete the database.'));
    request.onblocked = () => onBlocked?.();
  });
}

export function DangerZone() {
  const resetSettings = useSettings((s) => s.reset);
  const [dialog, setDialog] = useState<'reset' | 'delete' | null>(null);
  const close = () => setDialog(null);

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium">Reset settings</p>
          <p className="text-xs text-muted">Restore the defaults and remove your API key. Campaigns are kept.</p>
        </div>
        <Button icon={<RotateCcw className="size-4" aria-hidden />} onClick={() => setDialog('reset')}>
          Reset settings
        </Button>
      </div>
      <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium">Delete all local data</p>
          <p className="text-xs text-muted">
            Every campaign, import, homebrew entry and setting in this browser. Export anything you want to keep first.
          </p>
        </div>
        <Button variant="danger" icon={<Trash2 className="size-4" aria-hidden />} onClick={() => setDialog('delete')}>
          Delete everything
        </Button>
      </div>

      <Dialog
        open={dialog === 'reset'}
        onClose={close}
        size="sm"
        title="Reset all settings?"
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                resetSettings();
                close();
                toast.success('Settings reset to their defaults.');
              }}
            >
              Reset settings
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Model, appearance and cloud-save settings go back to their defaults, and your API key is removed from this
          browser. Your campaigns aren’t touched.
        </p>
      </Dialog>

      <DeleteEverythingDialog open={dialog === 'delete'} onClose={close} />
    </>
  );
}

function DeleteEverythingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const id = useId();
  const [typed, setTyped] = useState('');
  const [state, setState] = useState<'idle' | 'deleting' | 'blocked'>('idle');
  const confirmed = typed.trim() === CONFIRM_WORD;

  const close = () => {
    if (state !== 'idle') return;
    setTyped('');
    onClose();
  };

  const run = async () => {
    if (!confirmed) return;
    setState('deleting');
    try {
      await deleteAllLocalData(() => setState('blocked'));
      window.location.hash = '#/';
      window.location.reload();
    } catch (error) {
      setState('idle');
      toast.error(errorMessage(error, 'Could not delete the data.'));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={state === 'idle'}
      size="sm"
      title="Delete everything?"
      footer={
        <>
          <Button variant="ghost" disabled={state !== 'idle'} onClick={close}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!confirmed} loading={state !== 'idle'} onClick={() => void run()}>
            Delete everything
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <p>
          This permanently removes all campaigns, characters, imported books, homebrew, your API key and settings from
          this browser. Saves already exported or synced to GitHub are not affected.
        </p>
        <Field label={`Type ${CONFIRM_WORD} to confirm`} htmlFor={`${id}-confirm`}>
          <Input
            id={`${id}-confirm`}
            value={typed}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && confirmed) void run();
            }}
          />
        </Field>
        {state === 'blocked' && (
          <p role="status" className="text-gold">
            Another Solo DM tab is still open. Close it to finish deleting.
          </p>
        )}
      </div>
    </Dialog>
  );
}
