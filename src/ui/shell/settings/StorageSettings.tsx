/** Settings: whether this browser promises to keep the saves, and how to keep a copy elsewhere. */
import { useState } from 'react';
import { Info, Loader2, ShieldCheck } from 'lucide-react';
import { useSettings } from '@/state/settingsStore';
import { Button } from '@/ui/components/ui';
import { formatRelativeTime } from '../format';
import { useStoragePersistence, type StoragePersistence } from '../persistentStorage';
import { StatusLine } from './SettingsSection';

function PersistenceLine({ status }: { status: StoragePersistence }) {
  switch (status) {
    case 'checking':
      return (
        <StatusLine tone="muted" icon={<Loader2 className="size-4 animate-spin" aria-hidden />}>
          Checking how this browser keeps your saves…
        </StatusLine>
      );
    case 'persistent':
      return (
        <StatusLine tone="success" icon={<ShieldCheck className="size-4" aria-hidden />}>
          Storage: persistent. This browser won’t clear your saves to free up space.
        </StatusLine>
      );
    case 'best-effort':
      return (
        <StatusLine tone="gold" icon={<Info className="size-4" aria-hidden />}>
          Storage: may be cleared by the browser. Browsers can remove site data when the device runs low on space, and
          Safari does for sites you haven’t visited in a few weeks.
        </StatusLine>
      );
    case 'unknown':
      return (
        <StatusLine tone="muted" icon={<Info className="size-4" aria-hidden />}>
          This browser doesn’t say whether it will keep your saves.
        </StatusLine>
      );
  }
}

export function StorageSettings() {
  const { status, request } = useStoragePersistence();
  const lastSyncedAt = useSettings((s) => s.githubSync.lastSyncedAt);
  const [asking, setAsking] = useState(false);
  const [declined, setDeclined] = useState(false);

  const ask = async () => {
    setAsking(true);
    try {
      setDeclined(!(await request()));
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div aria-live="polite">
        <PersistenceLine status={status} />
      </div>
      {status === 'best-effort' && (
        <div className="flex flex-col items-start gap-2">
          <Button size="sm" loading={asking} onClick={() => void ask()}>
            Ask the browser to keep them
          </Button>
          {declined && (
            <p className="text-xs text-muted">
              The browser makes this call itself (installing Solo DM or bookmarking it can help). A backup works either
              way.
            </p>
          )}
        </div>
      )}
      <p className="text-sm text-muted">
        Your campaigns live only in this browser. To keep a copy somewhere else, export a save file from a campaign’s
        card on the Campaigns screen, or set up cloud saves on GitHub below.
        {lastSyncedAt ? ` Last synced to GitHub ${formatRelativeTime(lastSyncedAt)}.` : ''}
      </p>
    </div>
  );
}
