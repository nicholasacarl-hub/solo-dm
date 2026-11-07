import { useId, useState } from 'react';
import { OctagonX } from 'lucide-react';
import { useGame } from '@/state/gameStore';
import { toast } from '@/ui/components/toast';
import { Button, Input } from '@/ui/components/ui';
import { Popover } from '../components/Popover';
import { cancelDm, isBusyPhase, sendToDm, waitForDmIdle } from '../dmStatus';
import { X_CARD_MESSAGE, errorMessage } from '../format';

/** Add a veil to the campaign's safety settings (no duplicates, case-insensitive). */
async function addVeil(topic: string): Promise<void> {
  const { updateCampaign, queueDmNotice } = useGame.getState();
  await updateCampaign((c) => {
    const exists = c.settings.veils.some((v) => v.toLowerCase() === topic.toLowerCase());
    return exists ? c : { ...c, settings: { ...c.settings, veils: [...c.settings.veils, topic] } };
  });
  queueDmNotice(`Safety: the player added "${topic}" to the veils. Keep it off-screen from now on.`);
}

/**
 * Play the X-card: the DM steers away from the current content without discussion. If the DM is
 * mid-turn, that turn is stopped first.
 */
export async function playXCard(veil: string): Promise<void> {
  const topic = veil.trim();
  if (topic) {
    try {
      await addVeil(topic);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  if (isBusyPhase(useGame.getState().dm.phase)) {
    cancelDm();
    await waitForDmIdle();
  }
  await sendToDm(X_CARD_MESSAGE);
}

export function XCardButton() {
  const [open, setOpen] = useState(false);
  const [veil, setVeil] = useState('');
  const veilId = useId();

  const confirm = () => {
    const topic = veil;
    setOpen(false);
    setVeil('');
    void playXCard(topic);
  };

  return (
    <Popover
      label="X-card"
      placement="top-start"
      anchor="parent"
      open={open}
      onOpenChange={setOpen}
      className="w-80 max-w-full"
      trigger={({ ref, ...props }) => (
        <button
          ref={ref}
          type="button"
          {...props}
          title="X-card: steer away from this content"
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-semibold whitespace-nowrap text-muted transition-colors hover:bg-danger-soft hover:text-danger aria-expanded:bg-danger-soft aria-expanded:text-danger"
        >
          <OctagonX className="size-4" aria-hidden />
          X-card
        </button>
      )}
    >
      {(close) => (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            confirm();
          }}
          className="flex flex-col gap-3"
        >
          <div>
            <p className="font-medium">Steer away from this?</p>
            <p className="mt-0.5 text-xs text-muted">The DM changes course right away, no questions asked.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={veilId} className="text-sm font-medium">
              Also add a veil:
            </label>
            <Input
              id={veilId}
              value={veil}
              onChange={(e) => setVeil(e.target.value)}
              placeholder="Optional, e.g. spiders"
              autoComplete="off"
            />
            <p className="text-xs text-muted">Veiled topics happen off-screen from now on.</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" type="submit" data-autofocus>
              Steer away from this
            </Button>
          </div>
        </form>
      )}
    </Popover>
  );
}
