import { useEffect, type ReactNode } from 'react';
import { Swords } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { dm } from '@/dm';
import { useGame } from '@/state/gameStore';
import { Button, EmptyState } from '@/ui/components/ui';
import { CharacterSheet } from '@/ui/sheet/CharacterSheet';
import { CombatTracker } from './CombatTracker';
import { Composer } from './composer/Composer';
import { DmActivityBar } from './composer/DmActivityBar';
import { isBusyPhase, runDm } from './dmStatus';
import { PlayHeader } from './header/PlayHeader';
import { InteractionHost } from './InteractionHost';
import { JournalPanel } from './JournalPanel';
import { NarrativeLog } from './log/NarrativeLog';
import { MobileTabBar } from './MobileTabBar';
import { PanelBoundary } from './PanelBoundary';
import { usePlayView } from './playView';
import { RulesPanel } from './RulesPanel';
import { SceneCard } from './SceneCard';
import { useIsDesktop } from './useMediaQuery';

/**
 * The table: header, story (log + composer), scene/journal and character panels, and whatever the
 * DM is waiting on. Expects a loaded campaign with a character (see PlayScreen).
 */
export function PlayTable() {
  const isDesktop = useIsDesktop();
  useEffect(() => () => usePlayView.getState().reset(), []);
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text">
      <PlayHeader isDesktop={isDesktop} />
      {isDesktop ? <DesktopTable /> : <MobileTable />}
      <InteractionHost />
    </div>
  );
}

function DesktopTable() {
  const combatActive = useGame((s) => s.combat?.active ?? false);
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[16rem_minmax(0,1fr)_20rem] xl:grid-cols-[18rem_minmax(0,1fr)_24rem] 2xl:grid-cols-[20rem_minmax(0,1fr)_28rem]">
      <aside aria-label="Scene and journal" className="flex min-h-0 flex-col gap-3 overflow-y-auto border-r border-border p-3 scroll-thin xl:gap-4 xl:p-4">
        <PanelBoundary name="scene card">
          <SceneCard />
        </PanelBoundary>
        <PanelBoundary name="journal">
          <JournalPanel compact />
        </PanelBoundary>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-col">
        <StoryColumn />
      </main>
      <aside aria-label="Character" className="flex min-h-0 flex-col gap-3 overflow-y-auto border-l border-border p-3 scroll-thin xl:gap-4 xl:p-4">
        {combatActive && (
          <PanelBoundary name="combat tracker">
            <CombatTracker />
          </PanelBoundary>
        )}
        <SheetPanel />
      </aside>
    </div>
  );
}

function MobileTable() {
  const tab = usePlayView((s) => s.mobileTab);
  const combatActive = useGame((s) => s.combat?.active ?? false);
  const panel = (id: string, children: ReactNode) => (
    <section
      id={`play-panel-${id}`}
      role="tabpanel"
      aria-labelledby={`play-tab-${id}`}
      className="h-full overflow-y-auto overscroll-contain px-3 pt-3 pb-6 scroll-thin"
    >
      {children}
    </section>
  );

  return (
    <>
      <div className="min-h-0 flex-1 pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
        {/* The story stays mounted (hidden) so its scroll position and draft survive tab switches. */}
        <section
          id="play-panel-story"
          role="tabpanel"
          aria-labelledby="play-tab-story"
          hidden={tab !== 'story'}
          className="flex h-full flex-col"
        >
          <StoryColumn />
        </section>
        {tab === 'sheet' && panel('sheet', <SheetPanel />)}
        {tab === 'combat' &&
          panel(
            'combat',
            combatActive ? (
              <PanelBoundary name="combat tracker">
                <CombatTracker />
              </PanelBoundary>
            ) : (
              <EmptyState icon={<Swords className="size-8" aria-hidden />} title="No combat right now">
                When a fight breaks out, the initiative order appears here.
              </EmptyState>
            ),
          )}
        {tab === 'journal' &&
          panel(
            'journal',
            <div className="flex flex-col gap-3">
              <PanelBoundary name="scene card">
                <SceneCard />
              </PanelBoundary>
              <PanelBoundary name="journal">
                <JournalPanel />
              </PanelBoundary>
            </div>,
          )}
        {tab === 'rules' &&
          panel(
            'rules',
            <PanelBoundary name="rules lookup">
              <RulesPanel />
            </PanelBoundary>,
          )}
      </div>
      <MobileTabBar />
    </>
  );
}

function SheetPanel() {
  const character = useGame((s) => s.character);
  if (!character) return null;
  return (
    <PanelBoundary name="character sheet">
      <CharacterSheet character={character} variant="full" editable />
    </PanelBoundary>
  );
}

/** The narrative log with the composer (or "start the next session") underneath. */
function StoryColumn() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <NarrativeLog />
      <div className="mx-auto flex w-full max-w-[42rem] shrink-0 flex-col gap-2 px-3 pt-1 pb-3 sm:px-6 lg:pb-4">
        <StoryFooter />
      </div>
    </div>
  );
}

function StoryFooter() {
  const { hasSession, busy, sessionCount } = useGame(
    useShallow((s) => ({
      hasSession: s.activeSession !== null,
      busy: isBusyPhase(s.dm.phase),
      sessionCount: s.campaign?.sessionCount ?? 0,
    })),
  );
  return (
    <>
      <DmActivityBar />
      {!hasSession && !busy ? <NextSessionCard ended={sessionCount} /> : <Composer />}
    </>
  );
}

function NextSessionCard({ ended }: { ended: number }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-5 text-center shadow-card">
      <p className="text-sm text-muted">
        {ended > 0 ? `Session ${ended} is over. Take a break, or pick up where you left off.` : 'Your first session is ready to begin.'}
      </p>
      <Button variant="primary" onClick={() => void runDm(() => dm.beginOrResume())}>
        {ended > 0 ? `Start session ${ended + 1}` : 'Begin the adventure'}
      </Button>
    </div>
  );
}
