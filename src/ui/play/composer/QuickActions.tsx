import { useState } from 'react';
import { ArrowBigUpDash, CircleHelp, Coffee, Dices, ImageIcon, Moon, Plus } from 'lucide-react';
import { LevelUpDialog } from '@/ui/sheet/LevelUpDialog';
import { Menu, type MenuItem } from '../components/Menu';
import { sendToDm } from '../dmStatus';
import { OOC_PREFIX } from '../format';
import { useImagesAvailability } from '../images/availability';
import { IllustrationsOffDialog } from '../images/IllustrationsOffDialog';
import { usePlayView } from '../playView';
import { RollDiceDialog } from './RollDiceDialog';

export const SHORT_REST_MESSAGE = "I'd like to take a short rest.";
export const LONG_REST_MESSAGE = "I'd like to take a long rest.";
export const SHOW_SCENE_MESSAGE = 'OOC: Please show me an image of the current scene.';

/** The composer's "+" menu: roll a die yourself, ask a rules question, see the scene, rest, level up. */
export function QuickActions({ busy }: { busy: boolean }) {
  const [rolling, setRolling] = useState(false);
  const [levelingUp, setLevelingUp] = useState(false);
  /** Why pictures can't be made, while the player is reading about turning them on. */
  const [imagesOffReason, setImagesOffReason] = useState<string | null>(null);
  const prefillComposer = usePlayView((s) => s.prefillComposer);
  const images = useImagesAvailability();

  const items: MenuItem[] = [
    {
      id: 'roll',
      label: 'Roll dice…',
      icon: <Dices className="size-4" aria-hidden />,
      onSelect: () => setRolling(true),
    },
    {
      id: 'rules',
      label: 'Ask a rules question',
      hint: 'OOC',
      icon: <CircleHelp className="size-4" aria-hidden />,
      onSelect: () => prefillComposer(OOC_PREFIX),
    },
    {
      id: 'show-scene',
      label: 'Show me the scene',
      // Without illustrations it explains how to turn them on, so it stays available.
      hint: images.ok ? 'OOC' : 'Set up',
      icon: <ImageIcon className="size-4" aria-hidden />,
      disabled: images.ok && busy,
      onSelect: () => {
        if (images.ok) void sendToDm(SHOW_SCENE_MESSAGE);
        else setImagesOffReason(images.reason);
      },
    },
    {
      id: 'short-rest',
      label: 'Short rest',
      icon: <Coffee className="size-4" aria-hidden />,
      disabled: busy,
      onSelect: () => void sendToDm(SHORT_REST_MESSAGE),
    },
    {
      id: 'long-rest',
      label: 'Long rest',
      icon: <Moon className="size-4" aria-hidden />,
      disabled: busy,
      onSelect: () => void sendToDm(LONG_REST_MESSAGE),
    },
    {
      id: 'level-up',
      label: 'Level up…',
      icon: <ArrowBigUpDash className="size-4" aria-hidden />,
      onSelect: () => setLevelingUp(true),
    },
  ];

  return (
    <>
      <Menu
        label="Quick actions"
        placement="top-start"
        items={items}
        trigger={({ ref, ...props }) => (
          <button
            ref={ref}
            type="button"
            {...props}
            aria-label="Quick actions"
            title="Quick actions"
            className="inline-grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text aria-expanded:bg-surface-2 aria-expanded:text-text"
          >
            <Plus className="size-5" aria-hidden />
          </button>
        )}
      />
      <RollDiceDialog open={rolling} onClose={() => setRolling(false)} />
      <LevelUpDialog open={levelingUp} onClose={() => setLevelingUp(false)} />
      <IllustrationsOffDialog
        open={imagesOffReason !== null}
        reason={imagesOffReason ?? ''}
        onClose={() => setImagesOffReason(null)}
      />
    </>
  );
}
