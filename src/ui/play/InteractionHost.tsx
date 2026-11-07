import { useGame } from '@/state/gameStore';
import type { InteractionRequest } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { Button, Dialog } from '@/ui/components/ui';
import { ShortRestDialog } from '@/ui/sheet/ShortRestDialog';
import { cancelDm } from './dmStatus';
import { RollPromptDialog } from './RollPromptDialog';

/** Shows whatever the DM is waiting on (one interaction at a time) and hands the answer back. */
export function InteractionHost() {
  const interaction = useGame((s) => s.interaction);
  const rollMode = useGame((s) => s.campaign?.settings.playerRollMode ?? 'prompt');

  if (!interaction) return null;
  const { resolveInteraction, cancelInteraction } = useGame.getState();

  switch (interaction.kind) {
    case 'roll':
      return (
        <RollPromptDialog
          key={interaction.id}
          interaction={interaction}
          mode={rollMode}
          onResolve={(response) => useGame.getState().resolveInteraction(interaction.id, { kind: 'roll', response })}
          onCancelTurn={cancelDm}
        />
      );
    case 'short-rest':
      return (
        <ShortRestDialog
          key={interaction.id}
          request={interaction}
          onDone={(response) => resolveInteraction(interaction.id, { kind: 'short-rest', response })}
          onCancel={() => cancelInteraction(interaction.id, 'The player cancelled the short rest.')}
        />
      );
    case 'confirm':
      return <ConfirmInteraction key={interaction.id} interaction={interaction} />;
  }
}

function ConfirmInteraction({ interaction }: { interaction: Extract<InteractionRequest, { kind: 'confirm' }> }) {
  const answer = (confirmed: boolean) => useGame.getState().resolveInteraction(interaction.id, { kind: 'confirm', confirmed });
  return (
    <Dialog
      open
      onClose={() => answer(false)}
      dismissible={false}
      size="sm"
      title={interaction.title}
      footer={
        <>
          <Button variant="ghost" onClick={() => answer(false)}>
            {interaction.cancelLabel ?? 'Not now'}
          </Button>
          <Button variant="primary" onClick={() => answer(true)}>
            {interaction.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      <Markdown>{interaction.body}</Markdown>
    </Dialog>
  );
}
