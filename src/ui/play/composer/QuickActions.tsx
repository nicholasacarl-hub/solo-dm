import { useState } from 'react';
import { ArrowBigUpDash, CircleHelp, Coffee, Dices, Moon, Plus } from 'lucide-react';
import { LevelUpDialog } from '@/ui/sheet/LevelUpDialog';
import { Menu, type MenuItem } from '../components/Menu';
import { sendToDm } from '../dmStatus';
import { OOC_PREFIX } from '../format';
import { usePlayView } from '../playView';
import { RollDiceDialog } from './RollDiceDialog';

export const SHORT_REST_MESSAGE = "I'd like to take a short rest.";
export const LONG_REST_MESSAGE = "I'd like to take a long rest.";

/** The composer's "+" menu: roll a die yourself, ask a rules question, rest, level up. */
export function QuickActions({ busy }: { busy: boolean }) {
  const [rolling, setRolling] = useState(false);
  const [levelingUp, setLevelingUp] = useState(false);
  const prefillComposer = usePlayView((s) => s.prefillComposer);

  const items: MenuItem[] = [
    { id: 'roll', label: 'Roll dice…', icon: <Dices className="size-4" aria-hidden />, onSelect: () => setRolling(true) },
    {
      id: 'rules',
      label: 'Ask a rules question',
      hint: 'OOC',
      icon: <CircleHelp className="size-4" aria-hidden />,
      onSelect: () => prefillComposer(OOC_PREFIX),
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
    </>
  );
}
