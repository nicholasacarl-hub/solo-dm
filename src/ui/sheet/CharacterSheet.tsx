/**
 * Full or compact character sheet. With `editable`, every player edit goes through
 * useGame().updateCharacter and queues a DM notice describing the change; small roll buttons let the
 * player roll checks, saves and attacks unprompted (logged as "(unprompted)" and told to the DM).
 *
 * Built with container queries so it works in a ~360 px rail and in a full-width mobile tab.
 */
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Backpack, BookOpen, NotebookPen, Sparkles, Swords, UserRound } from 'lucide-react';
import { useGame } from '@/state/gameStore';
import type { Character, D20TestResult } from '@/types';
import { toast } from '@/ui/components/toast';
import { cn } from '@/lib/cn';
import { Button, Dialog, Input, Tabs } from '@/ui/components/ui';
import { AbilitiesGrid, OverviewPanel } from './AbilitiesPanel';
import { CombatPanel } from './CombatPanel';
import { FeaturesPanel } from './FeaturesPanel';
import { InventoryPanel } from './InventoryPanel';
import { LevelUpDialog } from './LevelUpDialog';
import { NotesPanel } from './NotesPanel';
import { SheetHeader } from './SheetHeader';
import { SpellsPanel } from './SpellsPanel';
import { deathSaveRollChange } from './sheetChanges';
import { manualResult, rollNow, useLogRoll, useSheetEdit, type SheetChange, type SheetRoll } from './useSheetActions';
import { VitalsPanel } from './VitalsPanel';

export interface CharacterSheetProps {
  character: Character;
  /** 'full' = tabs for everything (Play right rail / Sheet tab); 'compact' = vitals summary card. */
  variant?: 'full' | 'compact';
  editable?: boolean;
}

type SheetTab = 'overview' | 'combat' | 'spells' | 'inventory' | 'features' | 'notes';

const DEATH_SAVE_LABEL = 'Death saving throw';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Physical-dice mode: the player types what they rolled. */
function ManualRollDialog({ roll, onSubmit, onClose }: { roll: SheetRoll | null; onSubmit: (value: number) => string | null; onClose: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const d20 = roll?.kind === 'd20';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(value.trim());
    if (!value.trim() || !Number.isInteger(n)) return setError('Enter a whole number.');
    if (d20 && (n < 1 || n > 20)) return setError('A d20 shows a number from 1 to 20.');
    const problem = onSubmit(n);
    if (problem) return setError(problem);
    setValue('');
    setError(null);
  };
  const close = () => {
    setValue('');
    setError(null);
    onClose();
  };
  return (
    <Dialog
      open={roll !== null}
      onClose={close}
      size="sm"
      title={roll?.label ?? ''}
      description={d20 ? `Roll a d20 and enter the number on the die. Modifier: ${(roll?.modifier ?? 0) >= 0 ? '+' : '−'}${Math.abs(roll?.modifier ?? 0)}.` : `Roll ${roll?.expression ?? ''} and enter the total.`}
    >
      <form onSubmit={submit} className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor={inputId} className="text-sm font-medium">
            {d20 ? 'd20 result' : 'Total'}
          </label>
          <Input id={inputId} type="number" inputMode="numeric" autoFocus value={value} onChange={(e) => setValue(e.target.value)} className="tabular-nums" />
        </div>
        <Button type="submit" variant="primary">
          Log roll
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}

export function CharacterSheet({ character, variant = 'full', editable = false }: CharacterSheetProps) {
  const edit = useSheetEdit();
  const logRoll = useLogRoll();
  const rollMode = useGame((s) => s.campaign?.settings.playerRollMode ?? 'prompt');
  const [tab, setTab] = useState<SheetTab>('overview');
  const [manualRoll, setManualRoll] = useState<SheetRoll | null>(null);
  const [levelingUp, setLevelingUp] = useState(false);

  const onEdit = (change: (c: Character) => SheetChange) => {
    if (editable) void edit(change);
  };

  const finishRoll = (roll: SheetRoll, result: D20TestResult, manual: boolean) => {
    const deathSave = roll.label === DEATH_SAVE_LABEL ? result.natural : undefined;
    // A death save already tells the DM through its sheet change; every other roll queues its own notice.
    void logRoll(roll, result, manual, { tellDm: deathSave === undefined });
    if (deathSave !== undefined) void edit((c) => deathSaveRollChange(c, deathSave, result.total));
  };

  const onRoll = editable
    ? (roll: SheetRoll) => {
        if (rollMode === 'physical') {
          setManualRoll(roll);
          return;
        }
        try {
          finishRoll(roll, rollNow(roll), false);
        } catch (err) {
          toast.error(`Couldn't roll: ${errorText(err)}`);
        }
      }
    : undefined;

  const submitManual = (value: number): string | null => {
    if (!manualRoll) return null;
    try {
      finishRoll(manualRoll, manualResult(manualRoll, value), true);
      setManualRoll(null);
      return null;
    } catch (err) {
      return errorText(err);
    }
  };

  const header = <SheetHeader character={character} editable={editable} onLevelUp={editable ? () => setLevelingUp(true) : undefined} />;
  const vitals = <VitalsPanel character={character} editable={editable} onEdit={onEdit} onRoll={onRoll ?? (() => undefined)} />;
  const dialogs = editable && (
    <>
      <ManualRollDialog roll={manualRoll} onSubmit={submitManual} onClose={() => setManualRoll(null)} />
      <LevelUpDialog open={levelingUp} onClose={() => setLevelingUp(false)} />
    </>
  );

  if (variant === 'compact') {
    return (
      <div className="@container flex flex-col gap-3">
        {header}
        {vitals}
        <AbilitiesGrid character={character} onRoll={onRoll} />
        {dialogs}
      </div>
    );
  }

  const tabs: { value: SheetTab; label: string; icon: ReactNode }[] = [
    { value: 'overview', label: 'Overview', icon: <UserRound className="size-4" aria-hidden /> },
    { value: 'combat', label: 'Combat', icon: <Swords className="size-4" aria-hidden /> },
    { value: 'spells', label: 'Spells', icon: <Sparkles className="size-4" aria-hidden /> },
    { value: 'inventory', label: 'Inventory', icon: <Backpack className="size-4" aria-hidden /> },
    { value: 'features', label: 'Features', icon: <BookOpen className="size-4" aria-hidden /> },
    { value: 'notes', label: 'Notes', icon: <NotebookPen className="size-4" aria-hidden /> },
  ];
  const panelProps = { character, editable, onEdit };
  return (
    <div className="@container flex flex-col gap-4">
      {header}
      {vitals}
      <div className="flex flex-col gap-3">
        {/* In a narrow rail only the active tab keeps its text label; the others show their icon. */}
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={tabs.map((t) => ({ ...t, label: <span className={cn(t.value !== tab && '@max-sm:sr-only')}>{t.label}</span> }))}
          className="relative -mx-1 px-1"
        />
        <div role="tabpanel" aria-label={tabs.find((t) => t.value === tab)?.label}>
          {tab === 'overview' && <OverviewPanel character={character} onRoll={onRoll} />}
          {tab === 'combat' && <CombatPanel {...panelProps} onRoll={onRoll} />}
          {tab === 'spells' && <SpellsPanel {...panelProps} />}
          {tab === 'inventory' && <InventoryPanel {...panelProps} />}
          {tab === 'features' && <FeaturesPanel {...panelProps} />}
          {tab === 'notes' && <NotesPanel {...panelProps} />}
        </div>
      </div>
      {dialogs}
    </div>
  );
}
