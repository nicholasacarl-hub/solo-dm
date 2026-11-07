import { useState } from 'react';
import { dm } from '@/dm';
import { useGame } from '@/state/gameStore';
import type { CampaignSettings } from '@/types';
import { toast } from '@/ui/components/toast';
import { Button, Dialog } from '@/ui/components/ui';
import { CampaignSettingsForm } from '@/ui/shell/CampaignSettingsForm';
import { runDm } from '../dmStatus';
import { errorMessage } from '../format';
import { PanelBoundary } from '../PanelBoundary';
import { RulesPanel } from '../RulesPanel';
import { describeSettingsChanges, settingsChangeNotice } from './settingsDiff';

/** Confirm, then ask the DM to wrap up: final journal/quest updates and the recap. */
export function EndSessionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const number = useGame((s) => s.activeSession?.number ?? null);
  const confirm = () => {
    onClose();
    void runDm(() => dm.endSession());
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={number ? `End session ${number}?` : 'End the session?'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep playing
          </Button>
          <Button variant="primary" onClick={confirm}>
            End session
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">
        The DM records any last journal and quest updates, then writes a recap. The next session starts fresh from
        that recap, which keeps long campaigns fast and affordable.
      </p>
    </Dialog>
  );
}

/** "Table rules": edit the campaign settings mid-campaign; the DM is told what changed. */
export function TableRulesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Mounted only while open so the draft starts from the current settings every time.
  return open ? <TableRulesEditor onClose={onClose} /> : null;
}

function TableRulesEditor({ onClose }: { onClose: () => void }) {
  const original = useGame((s) => s.campaign?.settings ?? null);
  const [draft, setDraft] = useState<CampaignSettings | null>(original);
  const [saving, setSaving] = useState(false);
  const changes = original && draft ? describeSettingsChanges(original, draft) : [];

  const save = async () => {
    if (!draft || changes.length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const { updateCampaign, queueDmNotice } = useGame.getState();
      await updateCampaign((c) => ({ ...c, settings: draft }));
      queueDmNotice(settingsChangeNotice(changes));
      toast.success('Table rules updated. The DM will hear about it on your next turn.');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Table rules"
      description="How this campaign is run. Changes apply from your next turn."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={changes.length === 0}>
            Save changes
          </Button>
        </>
      }
    >
      {draft ? (
        <CampaignSettingsForm value={draft} onChange={setDraft} />
      ) : (
        <p className="text-sm text-muted">No campaign is loaded.</p>
      )}
    </Dialog>
  );
}

/** Desktop rules lookup (mobile has the Rules tab). */
export function RulesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Rules lookup" description="SRD 5.2.1, your imports and this campaign's homebrew.">
      <div className="min-h-[24rem]">
        <PanelBoundary name="rules lookup">
          <RulesPanel autoFocus onAskDm={onClose} />
        </PanelBoundary>
      </div>
    </Dialog>
  );
}
