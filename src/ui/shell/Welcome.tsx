/**
 * First-run welcome card and the gentle "how will you play?" banners on the Home screen.
 */
import { useNavigate } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { Feather, HardDrive, KeyRound, Plus, Sparkles, Upload, type LucideIcon } from 'lucide-react';
import { useSettings } from '@/state/settingsStore';
import { Button } from '@/ui/components/ui';
import { ButtonLink } from '@/ui/components/ButtonLink';
import { LanternMark } from '@/ui/components/LanternMark';
import { toast } from '@/ui/components/toast';

/** Location state that asks the Settings screen to focus the API key field. */
export const FOCUS_API_KEY_STATE = { focus: 'api-key' } as const;

function useDemoSwitch() {
  const update = useSettings((s) => s.update);
  const navigate = useNavigate();
  return (goTo?: string) => {
    update({ mockMode: true });
    toast.success('Demo DM is on. No API key needed.');
    if (goTo) navigate(goTo);
  };
}

function WelcomePoint({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: string }) {
  return (
    <li className="flex gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
        <Icon className="size-[18px]" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-0.5 text-sm text-muted">{children}</p>
      </div>
    </li>
  );
}

export function WelcomeCard({ onImport }: { onImport: () => void }) {
  const { apiKey, mockMode } = useSettings(useShallow((s) => ({ apiKey: s.apiKey, mockMode: s.mockMode })));
  const startDemo = useDemoSwitch();
  const ready = apiKey.trim() !== '' || mockMode;

  return (
    <section
      aria-labelledby="welcome-title"
      className="rounded-2xl border border-border bg-surface p-5 shadow-card sm:p-7"
    >
      <div className="flex items-center gap-3">
        <LanternMark className="size-10" />
        <div>
          <h2 id="welcome-title" className="font-display text-xl font-semibold tracking-wide">
            Welcome to the table
          </h2>
          <p className="text-sm text-muted">Solo campaigns with Claude as your Game Master.</p>
        </div>
      </div>

      <ul className="mt-6 grid grid-cols-1 gap-5 md:grid-cols-3 md:gap-6">
        <WelcomePoint icon={Feather} title="Claude is your DM">
          It narrates, voices every NPC and makes the rulings. The app keeps the books: your sheet, the dice and
          your quests.
        </WelcomePoint>
        <WelcomePoint icon={HardDrive} title="Everything stays in this browser">
          Campaigns, imported books and your key live on this device. Export a save file or sync to your own
          private GitHub repo.
        </WelcomePoint>
        <WelcomePoint icon={KeyRound} title="Bring your own Anthropic API key">
          Usage is billed by Anthropic, separately from any Claude subscription. Or try the demo DM first.
        </WelcomePoint>
      </ul>

      <div className="mt-7 flex flex-wrap items-center gap-2">
        {ready ? (
          <ButtonLink to="/new" variant="primary" icon={<Plus className="size-4" aria-hidden />}>
            Start your first campaign
          </ButtonLink>
        ) : (
          <>
            <ButtonLink
              to="/settings"
              state={FOCUS_API_KEY_STATE}
              variant="primary"
              icon={<KeyRound className="size-4" aria-hidden />}
            >
              Set up my API key
            </ButtonLink>
            <Button icon={<Sparkles className="size-4" aria-hidden />} onClick={() => startDemo('/new')}>
              Try the demo DM (no key needed)
            </Button>
          </>
        )}
        <Button variant="ghost" icon={<Upload className="size-4" aria-hidden />} onClick={onImport}>
          Import a save file
        </Button>
      </div>
      {ready && mockMode && !apiKey && (
        <p className="mt-3 text-xs text-muted">
          The demo DM is on: the story is scripted and nothing is sent to Claude. Add an API key in Settings
          whenever you’re ready for the real thing.
        </p>
      )}
    </section>
  );
}

/** Shown above the save slots when play would fail (no key) or is in demo mode. */
export function PlayReadinessBanner() {
  const { apiKey, mockMode, update } = useSettings(
    useShallow((s) => ({ apiKey: s.apiKey, mockMode: s.mockMode, update: s.update })),
  );
  const startDemo = useDemoSwitch();

  if (mockMode) {
    return (
      <div className="mb-5 flex flex-col gap-2 rounded-2xl border border-arcane/25 bg-arcane-soft/50 px-4 py-3 text-sm sm:flex-row sm:items-center sm:gap-3">
        <p className="flex min-w-0 flex-1 items-start gap-2.5">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-arcane" aria-hidden />
          <span>
            <span className="font-medium">Demo DM is on.</span>{' '}
            <span className="text-muted">The story is scripted and no requests are sent to Claude.</span>
          </span>
        </p>
        <Button size="sm" variant="ghost" className="self-start sm:self-auto" onClick={() => update({ mockMode: false })}>
          Turn off
        </Button>
      </div>
    );
  }
  if (apiKey.trim()) return null;
  return (
    <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-info/25 bg-info-soft/50 px-4 py-3 text-sm sm:flex-row sm:items-center">
      <p className="flex min-w-0 flex-1 items-start gap-2.5">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
        <span>
          <span className="font-medium">Add your Anthropic API key to play.</span>{' '}
          <span className="text-muted">Claude needs it to run the table, or you can try the offline demo DM.</span>
        </span>
      </p>
      <div className="flex gap-2 pl-6.5 sm:pl-0">
        <ButtonLink to="/settings" state={FOCUS_API_KEY_STATE} size="sm" variant="primary">
          Add key
        </ButtonLink>
        <Button size="sm" onClick={() => startDemo()}>
          Try demo
        </Button>
      </div>
    </div>
  );
}
