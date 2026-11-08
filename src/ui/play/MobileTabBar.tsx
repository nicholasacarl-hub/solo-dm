import { useEffect, useState } from 'react';
import { Library, NotebookPen, ScrollText, Swords, UserRound } from 'lucide-react';
import { playerTurnIndex } from '@/engine';
import { useGame, type GameStoreState } from '@/state/gameStore';
import { TabStrip, type TabStripItem } from './components/TabStrip';
import { usePlayView, type MobileTab } from './playView';

/**
 * The hero's turn in a fight on a battle map, as the player sees it: playerTurnIndex, so a hidden creature's turn
 * never changes the dot (D42).
 */
function heroTurnOnMap(s: Pick<GameStoreState, 'combat'>): boolean {
  const combat = s.combat;
  if (!combat?.active || !combat.map) return false;
  return combat.combatants[playerTurnIndex(combat)]?.isPlayer === true;
}

/** Bottom tab bar on phones: Story · Sheet · Combat · Journal · Rules. */
export function MobileTabBar() {
  const tab = usePlayView((s) => s.mobileTab);
  const setTab = usePlayView((s) => s.setMobileTab);
  const combatActive = useGame((s) => s.combat?.active ?? false);
  const yourTurn = useGame(heroTurnOnMap);
  const logLength = useGame((s) => s.log.length);
  const [seenLength, setSeenLength] = useState(logLength);

  // New story while another tab is open gets a dot on Story.
  useEffect(() => {
    if (tab === 'story') setSeenLength(logLength);
  }, [tab, logLength]);
  const unread = tab !== 'story' && logLength > seenLength;

  const items: TabStripItem<MobileTab>[] = [
    {
      value: 'story',
      label: 'Story',
      icon: <ScrollText className="size-5" aria-hidden />,
      dot: unread ? 'accent' : undefined,
      dotLabel: 'new',
    },
    { value: 'sheet', label: 'Sheet', icon: <UserRound className="size-5" aria-hidden /> },
    {
      value: 'combat',
      label: 'Combat',
      icon: <Swords className="size-5" aria-hidden />,
      dot: yourTurn ? 'accent' : combatActive ? 'danger' : undefined,
      dotLabel: yourTurn ? 'your turn' : 'combat in progress',
    },
    { value: 'journal', label: 'Journal', icon: <NotebookPen className="size-5" aria-hidden /> },
    { value: 'rules', label: 'Rules', icon: <Library className="size-5" aria-hidden /> },
  ];

  return (
    <div className="shrink-0 border-t border-border bg-surface pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
      <TabStrip label="Table views" items={items} value={tab} onChange={setTab} idPrefix="play" variant="bar" />
    </div>
  );
}
