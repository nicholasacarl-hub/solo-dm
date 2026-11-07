import { useState, type ComponentType } from 'react';
import { FlaskConical, History, Hourglass, NotebookPen, ScrollText } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Switch } from '@/ui/components/ui';
import { TabStrip, type TabStripItem } from './components/TabStrip';
import { ChronicleTab } from './journal/ChronicleTab';
import { ClocksTab } from './journal/ClocksTab';
import { HomebrewTab } from './journal/HomebrewTab';
import { JournalTab } from './journal/JournalTab';
import { QuestsTab } from './journal/QuestsTab';
import { usePlayView } from './playView';

export type JournalPanelTab = 'quests' | 'journal' | 'clocks' | 'homebrew' | 'chronicle';

const TABS: TabStripItem<JournalPanelTab>[] = [
  { value: 'quests', label: 'Quests', icon: <ScrollText className="size-4" aria-hidden /> },
  { value: 'journal', label: 'Journal', icon: <NotebookPen className="size-4" aria-hidden /> },
  { value: 'clocks', label: 'Clocks', icon: <Hourglass className="size-4" aria-hidden /> },
  { value: 'homebrew', label: 'Homebrew', icon: <FlaskConical className="size-4" aria-hidden /> },
  { value: 'chronicle', label: 'Chronicle', icon: <History className="size-4" aria-hidden /> },
];

const PANELS: Record<JournalPanelTab, ComponentType> = {
  quests: QuestsTab,
  journal: JournalTab,
  clocks: ClocksTab,
  homebrew: HomebrewTab,
  chronicle: ChronicleTab,
};

/** The campaign's memory as the player sees it: quests, journal, clocks, homebrew, recaps. */
export function JournalPanel({ className, compact = false }: { className?: string; compact?: boolean }) {
  const [tab, setTab] = useState<JournalPanelTab>('quests');
  const showSpoilers = usePlayView((s) => s.showSpoilers);
  const setShowSpoilers = usePlayView((s) => s.setShowSpoilers);
  const Panel = PANELS[tab];

  return (
    <section aria-label="Journal" className={cn('rounded-2xl border border-border bg-surface shadow-card', className)}>
      <TabStrip
        label="Journal sections"
        items={TABS}
        value={tab}
        onChange={setTab}
        idPrefix="journal"
        labels={compact ? 'selected' : 'always'}
        className="px-1.5 pt-1"
      />
      <div
        id={`journal-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`journal-tab-${tab}`}
        tabIndex={0}
        className="rounded-b-2xl bg-bg/40 p-3 focus-visible:outline-offset-[-2px]"
      >
        <Panel />
      </div>
      <div className="border-t border-border px-3 py-3">
        <Switch
          checked={showSpoilers}
          onChange={setShowSpoilers}
          label="Show DM secrets (spoilers)"
          description="Secret entries, clocks and DM notes."
        />
      </div>
    </section>
  );
}
