/** Route: #/ — save slots (one card per campaign), first-run welcome, import/export. */
import { useState } from 'react';
import { Plus, Upload } from 'lucide-react';
import { deleteCampaign, useCampaignList, type CampaignSummary } from '@/storage';
import { useGame } from '@/state/gameStore';
import { Button, Dialog } from '@/ui/components/ui';
import { ButtonLink } from '@/ui/components/ButtonLink';
import { ErrorBoundary } from '@/ui/components/ErrorBoundary';
import { toast } from '@/ui/components/toast';
import { CampaignCard, CampaignCardSkeleton } from '@/ui/shell/CampaignCard';
import { Page, PageHeader, useDocumentTitle } from '@/ui/shell/Page';
import { PlayReadinessBanner, WelcomeCard } from '@/ui/shell/Welcome';
import { errorMessage } from '@/ui/shell/format';
import { useSaveFileImport } from '@/ui/shell/useSaveFileImport';

export function HomeScreen() {
  useDocumentTitle('Campaigns');
  const importer = useSaveFileImport();
  return (
    <Page>
      <PageHeader
        title="Campaigns"
        description="Each campaign is a save slot with its own hero, history and table rules."
        actions={
          <>
            <Button icon={<Upload className="size-4" aria-hidden />} loading={importer.busy} onClick={importer.openPicker}>
              Import save
            </Button>
            <ButtonLink to="/new" variant="primary" icon={<Plus className="size-4" aria-hidden />}>
              New campaign
            </ButtonLink>
          </>
        }
      />
      <ErrorBoundary label="Your campaigns">
        <CampaignSlots onImport={importer.openPicker} />
      </ErrorBoundary>
      {importer.element}
    </Page>
  );
}

function CampaignSlots({ onImport }: { onImport: () => void }) {
  const campaigns = useCampaignList();
  const [toDelete, setToDelete] = useState<CampaignSummary | null>(null);

  if (campaigns === undefined) {
    return (
      <div aria-busy="true" aria-label="Loading campaigns" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <CampaignCardSkeleton />
        <CampaignCardSkeleton />
      </div>
    );
  }
  if (campaigns.length === 0) return <WelcomeCard onImport={onImport} />;

  return (
    <>
      <PlayReadinessBanner />
      <ul aria-label="Your campaigns" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {campaigns.map((summary) => (
          <li key={summary.campaign.id} className="min-w-0">
            <CampaignCard summary={summary} onDelete={() => setToDelete(summary)} />
          </li>
        ))}
      </ul>
      <DeleteCampaignDialog summary={toDelete} onClose={() => setToDelete(null)} />
    </>
  );
}

function DeleteCampaignDialog({ summary, onClose }: { summary: CampaignSummary | null; onClose: () => void }) {
  const [deleting, setDeleting] = useState(false);

  const confirm = async () => {
    if (!summary) return;
    const { id, name } = summary.campaign;
    setDeleting(true);
    try {
      await deleteCampaign(id);
      unloadIfLoaded(id);
      toast.success(`Deleted “${name}”.`);
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not delete the campaign.'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog
      open={summary !== null}
      onClose={() => {
        if (!deleting) onClose();
      }}
      size="sm"
      title="Delete this campaign?"
      footer={
        <>
          <Button variant="ghost" disabled={deleting} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={deleting} onClick={() => void confirm()}>
            Delete campaign
          </Button>
        </>
      }
    >
      {summary && (
        <div className="flex flex-col gap-2 text-sm">
          <p>
            “{summary.campaign.name}”, its character, sessions, journal and log will be removed from this browser. This
            can’t be undone.
          </p>
          <p className="text-muted">Want a backup? Close this and use Export first.</p>
        </div>
      )}
    </Dialog>
  );
}

/** Drop a deleted campaign from memory so the Play screen can't show stale data. */
function unloadIfLoaded(campaignId: string): void {
  try {
    const game = useGame.getState();
    if (game.campaignId === campaignId) game.unloadCampaign();
  } catch {
    // The game store is optional here; nothing to unload.
  }
}
