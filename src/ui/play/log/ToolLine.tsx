import { useId, useState } from 'react';
import {
  Activity,
  ArrowBigUpDash,
  Backpack,
  BookOpen,
  ChevronDown,
  Coins,
  Dna,
  EyeOff,
  FlaskConical,
  HeartCrack,
  HeartPulse,
  ImageIcon,
  Info,
  MapPin,
  Moon,
  NotebookPen,
  Orbit,
  ScrollText,
  Sparkles,
  Star,
  Swords,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useGame } from '@/state/gameStore';
import type { ToolActivityIcon, ToolLogEntry } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { HomebrewViewer } from '../HomebrewViewer';
import { findHomebrewInText, homebrewNameFromSummary, isHomebrewLine, vetoHomebrew } from '../homebrew';
import { usePlayView } from '../playView';

const ICONS: Record<ToolActivityIcon, { Icon: LucideIcon; tone: string }> = {
  hp: { Icon: HeartCrack, tone: 'text-danger' },
  heal: { Icon: HeartPulse, tone: 'text-success' },
  condition: { Icon: Activity, tone: 'text-danger' },
  item: { Icon: Backpack, tone: 'text-gold' },
  coin: { Icon: Coins, tone: 'text-gold' },
  xp: { Icon: Star, tone: 'text-gold' },
  level: { Icon: ArrowBigUpDash, tone: 'text-gold' },
  spell: { Icon: Sparkles, tone: 'text-arcane' },
  rest: { Icon: Moon, tone: 'text-info' },
  combat: { Icon: Swords, tone: 'text-danger' },
  journal: { Icon: NotebookPen, tone: 'text-muted' },
  quest: { Icon: ScrollText, tone: 'text-accent' },
  scene: { Icon: MapPin, tone: 'text-info' },
  rules: { Icon: BookOpen, tone: 'text-muted' },
  homebrew: { Icon: FlaskConical, tone: 'text-arcane' },
  oracle: { Icon: Orbit, tone: 'text-arcane' },
  info: { Icon: Info, tone: 'text-muted' },
  transform: { Icon: Dna, tone: 'text-arcane' },
  image: { Icon: ImageIcon, tone: 'text-info' },
};

/** A compact "something changed" line: icon, one-line summary, optional expandable detail. */
export function ToolLine({ entry }: { entry: ToolLogEntry }) {
  const spoilers = usePlayView((s) => s.showSpoilers);
  const [revealed, setRevealed] = useState(false);
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const { Icon, tone } = ICONS[entry.icon] ?? ICONS.info;

  if (entry.secret && !spoilers && !revealed) {
    return (
      <div className="flex items-center gap-2 text-sm text-faint">
        <EyeOff className="size-4 shrink-0" aria-hidden />
        <span className="italic">The DM made a secret note.</span>
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="rounded-md px-1.5 text-xs font-medium text-muted underline-offset-2 hover:text-text hover:underline"
        >
          Reveal
        </button>
      </div>
    );
  }

  if (entry.icon === 'transform') return <TransformationLine entry={entry} />;

  return (
    <div className="flex items-start gap-2.5 text-sm">
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 text-muted">{entry.summary}</p>
          {entry.detail && (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailId}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-0.5 rounded-md px-1 text-xs font-medium text-faint hover:text-text"
            >
              Details
              <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
            </button>
          )}
          {isHomebrewLine(entry) && <HomebrewActions entry={entry} />}
        </div>
        {entry.detail && open && (
          <div id={detailId} className="mt-1.5 rounded-xl border border-border bg-surface px-3 py-2">
            <Markdown>{entry.detail}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}

/** "Transformation: Moonblood begins" under the "Transformation" heading reads "Moonblood begins". */
function withoutEyebrow(summary: string): string {
  return summary.replace(/^\s*transformation\s*:\s*/i, '') || summary;
}

/**
 * A transformation taking hold, advancing or ending: a turning point for the hero, so it gets an
 * arcane card with what changed shown, not a one-line note that is easy to scroll past.
 */
function TransformationLine({ entry }: { entry: ToolLogEntry }) {
  const [open, setOpen] = useState(true);
  const detailId = useId();
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="rounded-2xl border border-arcane/40 bg-arcane-soft/60 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full border border-arcane/40 bg-surface text-arcane">
          <Dna className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="font-display text-[0.6875rem] font-semibold tracking-[0.16em] text-arcane uppercase">
            Transformation
          </h3>
          <p className="mt-0.5 text-[0.9375rem] leading-snug font-medium text-text">{withoutEyebrow(entry.summary)}</p>
          {entry.detail && (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailId}
              onClick={() => setOpen((v) => !v)}
              className="mt-1 -ml-1 inline-flex items-center gap-0.5 rounded-md px-1 text-xs font-medium text-arcane hover:bg-surface/60"
            >
              {open ? 'Hide what changed' : 'What changed'}
              <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
            </button>
          )}
        </div>
      </div>
      {entry.detail && open && (
        <div id={detailId} className="mt-2.5 rounded-xl border border-arcane/25 bg-surface px-3 py-2">
          <Markdown>{entry.detail}</Markdown>
        </div>
      )}
    </section>
  );
}

/** "View" and "Veto" for homebrew lines. */
function HomebrewActions({ entry }: { entry: ToolLogEntry }) {
  const homebrew = useGame((s) => s.homebrew);
  const [viewing, setViewing] = useState(false);
  const [vetoed, setVetoed] = useState(false);
  const match = (entry.refId ? homebrew.find((h) => h.id === entry.refId) : undefined) ?? findHomebrewInText(entry.summary, homebrew);
  const name = match?.name ?? homebrewNameFromSummary(entry.summary);

  const veto = () => {
    vetoHomebrew(name);
    setVetoed(true);
  };

  return (
    <>
      <span className="inline-flex items-center gap-1">
        <button
          type="button"
          onClick={() => setViewing(true)}
          className="rounded-md px-1.5 text-xs font-medium text-arcane hover:bg-arcane-soft"
          aria-label={`View homebrew ${name}`}
        >
          View
        </button>
        <button
          type="button"
          onClick={veto}
          disabled={vetoed}
          className="rounded-md px-1.5 text-xs font-medium text-muted hover:bg-danger-soft hover:text-danger disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
          aria-label={vetoed ? `Vetoed homebrew ${name}` : `Veto homebrew ${name}`}
        >
          {vetoed ? 'Vetoed' : 'Veto'}
        </button>
      </span>
      <HomebrewViewer
        open={viewing}
        onClose={() => setViewing(false)}
        entry={match}
        fallbackTitle={name}
        fallbackText={entry.detail}
        onVeto={match?.status === 'retired' ? undefined : veto}
        vetoed={vetoed}
      />
    </>
  );
}
