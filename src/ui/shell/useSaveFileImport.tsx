/**
 * "Import save file": pick a .solodm.json file, validate it, and import it. When a campaign with
 * the same id is already on this device, ask whether to replace it or import a copy.
 */
import { useRef, useState, type ReactNode } from 'react';
import { getCampaign, importCampaignBundle, parseCampaignBundle, type CampaignBundle } from '@/storage';
import type { Campaign } from '@/types';
import { Button, Dialog } from '@/ui/components/ui';
import { toast } from '@/ui/components/toast';
import { errorMessage, formatRelativeTime } from './format';

interface Conflict {
  bundle: CampaignBundle;
  existing: Campaign;
}

async function readJsonFile(file: File): Promise<unknown> {
  const text = await file.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`“${file.name}” isn’t a Solo DM save file (it isn’t valid JSON).`);
  }
}

export function useSaveFileImport(): { openPicker: () => void; busy: boolean; element: ReactNode } {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);

  const runImport = async (bundle: CampaignBundle, mode?: 'replace' | 'copy') => {
    setBusy(true);
    try {
      const campaign = await importCampaignBundle(bundle, mode);
      toast.success(mode === 'copy' ? `Imported a copy of “${campaign.name}”.` : `Imported “${campaign.name}”.`);
      setConflict(null);
    } catch (error) {
      toast.error(errorMessage(error, 'Could not import that save file.'));
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (file: File) => {
    setBusy(true);
    try {
      const bundle = parseCampaignBundle(await readJsonFile(file));
      const existing = await getCampaign(bundle.campaign.id);
      if (existing) {
        setConflict({ bundle, existing });
        setBusy(false);
        return;
      }
      await runImport(bundle);
    } catch (error) {
      toast.error(errorMessage(error, 'Could not read that save file.'));
      setBusy(false);
    }
  };

  const element = (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void handleFile(file);
        }}
      />
      <Dialog
        open={conflict !== null}
        onClose={() => {
          if (!busy) setConflict(null);
        }}
        size="sm"
        title="This campaign is already here"
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setConflict(null)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => conflict && void runImport(conflict.bundle, 'replace')}>
              Replace
            </Button>
            <Button variant="primary" loading={busy} onClick={() => conflict && void runImport(conflict.bundle, 'copy')}>
              Import as copy
            </Button>
          </>
        }
      >
        {conflict && (
          <div className="flex flex-col gap-3 text-sm">
            <p>
              “{conflict.existing.name}” is already on this device
              {conflict.existing.lastPlayedAt ? `, last played ${formatRelativeTime(conflict.existing.lastPlayedAt)}` : ''}.
              The save file was exported {formatRelativeTime(conflict.bundle.exportedAt)}.
            </p>
            <ul className="flex flex-col gap-1.5 text-muted">
              <li>
                <span className="font-medium text-text">Replace</span> overwrites the campaign on this device with the
                save file.
              </li>
              <li>
                <span className="font-medium text-text">Import as copy</span> keeps both.
              </li>
            </ul>
          </div>
        )}
      </Dialog>
    </>
  );

  return { openPicker: () => inputRef.current?.click(), busy, element };
}
