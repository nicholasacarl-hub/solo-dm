import { Settings } from 'lucide-react';
import { ButtonLink } from '@/ui/components/ButtonLink';
import { Button, Dialog } from '@/ui/components/ui';
import { IMAGE_SETTINGS_LINK } from './availability';

/** Why the DM can't paint right now, and where to turn illustrations on. */
export function IllustrationsOffDialog({ open, reason, onClose }: { open: boolean; reason: string; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Turn on illustrations"
      description={reason}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <ButtonLink to={IMAGE_SETTINGS_LINK} variant="primary" icon={<Settings className="size-4" aria-hidden />}>
            Open Settings
          </ButtonLink>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-sm text-muted">
        <p>
          Your DM can paint the scene, the people you meet and the creatures you face. The pictures are made by
          OpenAI’s image models with your own OpenAI API key, which stays in this browser.
        </p>
        <p>Each picture costs a few cents on your OpenAI account.</p>
      </div>
    </Dialog>
  );
}
