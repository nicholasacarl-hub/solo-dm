import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, BookOpen, Ellipsis, Eye, EyeOff, Flag, MapPin, Settings, SlidersHorizontal } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '@/lib/cn';
import { useGame } from '@/state/gameStore';
import { useSettings } from '@/state/settingsStore';
import { Badge, Button, Switch } from '@/ui/components/ui';
import { Popover } from '../components/Popover';
import { isBusyPhase } from '../dmStatus';
import { sceneSummary } from '../format';
import { usePlayView } from '../playView';
import { EndSessionDialog, RulesDialog, TableRulesDialog } from './SessionDialogs';
import { ContextMeter, CostReadout, ModelReadout, UsagePill } from './UsageMeters';

type OpenDialog = 'end' | 'rules' | 'table' | null;

const iconButton =
  'inline-grid size-9 shrink-0 place-items-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-text';

/** The table's header: where you are, what it costs, and the session controls. */
export function PlayHeader({ isDesktop }: { isDesktop: boolean }) {
  const { name, cover, scene, showDmRolls, sessionNumber, sessionCount, hasSession, busy } = useGame(
    useShallow((s) => ({
      name: s.campaign?.name ?? '',
      cover: s.campaign?.coverEmoji ?? null,
      scene: s.campaign?.scene ?? null,
      showDmRolls: s.campaign?.settings.showDmRolls ?? false,
      sessionNumber: s.activeSession?.number ?? null,
      sessionCount: s.campaign?.sessionCount ?? 0,
      hasSession: s.activeSession !== null,
      busy: isBusyPhase(s.dm.phase),
    })),
  );
  const mockMode = useSettings((s) => s.mockMode);
  const revealAll = usePlayView((s) => s.revealAllDmRolls);
  const setRevealAll = usePlayView((s) => s.setRevealAllDmRolls);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const close = () => setDialog(null);

  const sessionText = sessionNumber
    ? `Session ${sessionNumber}`
    : sessionCount > 0
      ? `Session ${sessionCount} ended`
      : 'Not started';
  const where = sceneSummary(scene);
  const endDisabled = !hasSession || busy;
  const endTitle = !hasSession ? 'No session in progress' : busy ? 'Wait for the DM to finish' : 'End this session';

  return (
    <header className="shrink-0 border-b border-border bg-surface pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
      <div className="flex h-14 items-center gap-2 px-2 sm:px-3">
        <Link to="/" aria-label="Back to campaigns" title="Back to campaigns" className={iconButton}>
          <ArrowLeft className="size-5" aria-hidden />
        </Link>

        <div className="flex min-w-0 shrink-[2] items-center gap-2.5">
          {cover && (
            <span className="hidden text-xl sm:inline" aria-hidden>
              {cover}
            </span>
          )}
          <div className="min-w-0">
            <h1 className="truncate font-serif text-base leading-tight font-semibold">{name}</h1>
            <p className="truncate text-xs text-muted">
              {sessionText}
              {!isDesktop && scene?.location ? ` · ${scene.location}` : ''}
            </p>
          </div>
        </div>

        {isDesktop && where && (
          <p
            className="ml-2 flex max-w-md min-w-0 shrink items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 py-1 text-xs text-muted"
            title={where}
          >
            <MapPin className="size-3.5 shrink-0 text-info" aria-hidden />
            <span className="sr-only">Scene: </span>
            <span className="truncate">{where}</span>
          </p>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {mockMode && (
            <Badge tone="info" className="mr-1">
              Demo
            </Badge>
          )}
          {isDesktop ? (
            <>
              <div className="mr-1">
                <UsagePill />
              </div>
              {!showDmRolls && (
                <button
                  type="button"
                  aria-pressed={revealAll}
                  onClick={() => setRevealAll(!revealAll)}
                  className={cn(iconButton, revealAll && 'bg-surface-2 text-text')}
                  title={revealAll ? 'Hide DM rolls again' : 'Reveal all DM rolls'}
                  aria-label="Reveal all DM rolls"
                >
                  {revealAll ? <Eye className="size-5" aria-hidden /> : <EyeOff className="size-5" aria-hidden />}
                </button>
              )}
              <button
                type="button"
                className={iconButton}
                onClick={() => setDialog('rules')}
                aria-label="Rules lookup"
                title="Rules lookup"
              >
                <BookOpen className="size-5" aria-hidden />
              </button>
              <button
                type="button"
                className={iconButton}
                onClick={() => setDialog('table')}
                aria-label="Table rules"
                title="Table rules"
              >
                <SlidersHorizontal className="size-5" aria-hidden />
              </button>
              <Button
                size="sm"
                variant="secondary"
                className="ml-1"
                onClick={() => setDialog('end')}
                disabled={endDisabled}
                title={endTitle}
                icon={<Flag className="size-3.5" aria-hidden />}
              >
                End session
              </Button>
              <Link to="/settings" aria-label="Settings" title="Settings" className={iconButton}>
                <Settings className="size-5" aria-hidden />
              </Link>
            </>
          ) : (
            <MobileMenu
              showRevealToggle={!showDmRolls}
              revealAll={revealAll}
              onRevealAll={setRevealAll}
              endDisabled={endDisabled}
              onOpen={setDialog}
            />
          )}
        </div>
      </div>
      <EndSessionDialog open={dialog === 'end'} onClose={close} />
      <TableRulesDialog open={dialog === 'table'} onClose={close} />
      {isDesktop && <RulesDialog open={dialog === 'rules'} onClose={close} />}
    </header>
  );
}

function MobileMenu({
  showRevealToggle,
  revealAll,
  onRevealAll,
  endDisabled,
  onOpen,
}: {
  showRevealToggle: boolean;
  revealAll: boolean;
  onRevealAll: (value: boolean) => void;
  endDisabled: boolean;
  onOpen: (dialog: OpenDialog) => void;
}) {
  const [open, setOpen] = useState(false);
  const choose = (dialog: OpenDialog) => {
    setOpen(false);
    onOpen(dialog);
  };
  return (
    <Popover
      label="Table menu"
      placement="bottom-end"
      open={open}
      onOpenChange={setOpen}
      className="w-[min(20rem,calc(100vw-1.5rem))]!"
      trigger={({ ref, ...props }) => (
        <button ref={ref} type="button" {...props} aria-label="Table menu" title="Table menu" className={iconButton}>
          <Ellipsis className="size-5" aria-hidden />
        </button>
      )}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 rounded-xl bg-surface-2 p-3">
          <ContextMeter />
          <CostReadout />
          <ModelReadout />
        </div>
        {showRevealToggle && (
          <Switch
            checked={revealAll}
            onChange={onRevealAll}
            label="Reveal all DM rolls"
            description="Show the DM's secret rolls in this view."
          />
        )}
        <div className="flex flex-col gap-1">
          <Button
            variant="ghost"
            className="justify-start!"
            onClick={() => choose('table')}
            icon={<SlidersHorizontal className="size-4" aria-hidden />}
          >
            Table rules
          </Button>
          <Button
            variant="ghost"
            className="justify-start!"
            onClick={() => choose('end')}
            disabled={endDisabled}
            icon={<Flag className="size-4" aria-hidden />}
          >
            End session
          </Button>
          <Link
            to="/settings"
            className="inline-flex h-10 items-center gap-2 rounded-xl px-4 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <Settings className="size-4" aria-hidden />
            Settings
          </Link>
        </div>
      </div>
    </Popover>
  );
}
