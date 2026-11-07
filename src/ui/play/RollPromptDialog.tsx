import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Dices, Hand } from 'lucide-react';
import { cn } from '@/lib/cn';
import { manualD20Result, manualRollResult, rollD20Test, rollDice } from '@/engine';
import { useGame } from '@/state/gameStore';
import { useSettings } from '@/state/settingsStore';
import type { D20TestResult, InteractionRequest, PlayerRollMode, PlayerRollResponse } from '@/types';
import { Badge, Button, Dialog, Input } from '@/ui/components/ui';
import { D20Face } from './dice/D20Face';
import { TONE_TEXT, outcomeBadges, primaryTone, targetLabel, type OutcomeBadge } from './dice/rollDisplay';
import {
  criticalExpression,
  diceExpression,
  effectiveDc,
  formatParts,
  modifierParts,
  physicalInstructions,
  rollKind,
  withAttackRollRules,
} from './dice/rollRequest';
import { errorMessage, joinedModifier, signed } from './format';
import { usePrefersReducedMotion } from './useMediaQuery';

/** How long the dice tumble before landing. */
export const ROLL_ANIMATION_MS = 650;
/** How long a tapped roll's result stays up before the DM continues (Continue skips the wait). */
export const RESULT_HOLD_MS = 1100;

type RollInteraction = Extract<InteractionRequest, { kind: 'roll' }>;
type Stage = 'ready' | 'rolling' | 'result';

export interface RollPromptDialogProps {
  interaction: RollInteraction;
  /** The campaign's roll mode. 'auto' never reaches the UI; if it does, the tap-to-roll prompt is shown. */
  mode: PlayerRollMode;
  onResolve: (response: PlayerRollResponse) => void;
  /** Stop the DM's turn instead of rolling (e.g. the player wants to take the action back). */
  onCancelTurn?: () => void;
}

/**
 * The roll the DM is waiting on. Not dismissible: the player rolls (tap or physical dice) or
 * explicitly cancels the DM's turn.
 */
export function RollPromptDialog({ interaction, mode, onResolve, onCancelTurn }: RollPromptDialogProps) {
  const { request, modifier, label } = interaction;
  const character = useGame((s) => s.character);
  const diceAnimations = useSettings((s) => s.diceAnimations);
  const reducedMotion = usePrefersReducedMotion();
  const animate = diceAnimations && !reducedMotion;
  const physical = mode === 'physical';
  const kind = rollKind(request);
  const dc = effectiveDc(request);
  const baseExpression = kind === 'dice' ? diceExpression(request, character) : null;
  const expression = baseExpression && request.critical ? criticalExpression(baseExpression) : baseExpression;
  const parts = kind === 'd20' ? modifierParts(character, request, modifier) : [];

  const [stage, setStage] = useState<Stage>('ready');
  const [result, setResult] = useState<D20TestResult | null>(null);
  const [manual, setManual] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolvedRef = useRef(false);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const finish = (final: D20TestResult, isManual: boolean) => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    onResolve({ result: final, manual: isManual });
  };

  // Focus the main control once the modal is showing (the dialog opens after children mount).
  useEffect(() => {
    if (stage === 'rolling') return;
    const id = window.setTimeout(
      () => (stage === 'ready' && physical ? inputRef.current : primaryRef.current)?.focus(),
      0,
    );
    return () => window.clearTimeout(id);
  }, [stage, physical]);

  // Land the dice after the tumble.
  useEffect(() => {
    if (stage !== 'rolling') return;
    const id = window.setTimeout(() => setStage('result'), ROLL_ANIMATION_MS);
    return () => window.clearTimeout(id);
  }, [stage]);

  // Tapped rolls continue on their own after a moment; physical rolls wait for Continue.
  useEffect(() => {
    if (stage !== 'result' || !result || manual) return;
    const id = window.setTimeout(() => finish(result, false), RESULT_HOLD_MS);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, result, manual]);

  const judge = (raw: D20TestResult) => (request.rollType === 'attack' ? withAttackRollRules(raw) : raw);

  const rollNow = () => {
    try {
      const rolled =
        kind === 'd20'
          ? judge(rollD20Test(modifier, { advantage: request.advantage, dc }))
          : rollDice(baseExpression ?? '1d20', { critical: request.critical });
      setResult(rolled);
      setManual(false);
      setError(null);
      setStage(animate ? 'rolling' : 'result');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const submitManual = (value: string) => {
    const n = Number(value.trim());
    if (!value.trim() || !Number.isInteger(n)) {
      setError('Enter a whole number.');
      return;
    }
    if (kind === 'd20' && (n < 1 || n > 20)) {
      setError('A d20 shows a number from 1 to 20.');
      return;
    }
    try {
      const entered =
        kind === 'd20'
          ? judge(manualD20Result(n, modifier, { advantage: request.advantage, dc }))
          : manualRollResult(expression ?? '1d20', n);
      setResult(entered);
      setManual(true);
      setError(null);
      setStage('result');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const showTarget = request.revealDc && dc !== undefined;
  const target = targetLabel({ rollType: request.rollType });

  return (
    <Dialog
      open
      onClose={() => {}}
      dismissible={false}
      size="sm"
      title={label}
      description={request.reason}
      footer={
        onCancelTurn && stage === 'ready' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancelTurn}
            title="Stop the DM's turn so you can rephrase your action"
          >
            Cancel turn
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col items-center gap-4 py-1 text-center">
        <RollFace stage={stage} kind={kind} result={result} request={interaction.request} />

        <div className="flex flex-col items-center gap-1.5">
          <p className="font-mono text-sm text-muted">
            {kind === 'd20' ? `d20${joinedModifier(modifier)}` : expression}
          </p>
          <div className="flex flex-wrap justify-center gap-1.5">
            {request.advantage === 'advantage' && <Badge tone="success">Advantage</Badge>}
            {request.advantage === 'disadvantage' && <Badge tone="danger">Disadvantage</Badge>}
            {showTarget && (
              <Badge tone="accent">
                {target} {dc}
              </Badge>
            )}
            {request.critical && kind === 'dice' && <Badge tone="gold">Critical hit: dice doubled</Badge>}
          </div>
          {parts.length > 0 && <p className="text-xs text-faint">{formatParts(parts)}</p>}
        </div>

        {stage === 'result' && result && (
          <RollResultSummary
            result={result}
            kind={kind}
            attack={request.rollType === 'attack'}
            showOutcome={showTarget}
            deathSave={request.rollType === 'death-save'}
          />
        )}

        <p className="sr-only" aria-live="polite">
          {stage === 'result' && result ? announceResult(result, kind, showTarget, request.rollType === 'attack') : ''}
        </p>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        {(stage === 'ready' || stage === 'rolling') && !physical && (
          <Button
            ref={primaryRef}
            variant="primary"
            size="lg"
            className="w-full"
            onClick={rollNow}
            loading={stage === 'rolling'}
            icon={<Dices className="size-5" aria-hidden />}
          >
            {stage === 'rolling' ? 'Rolling…' : 'Roll'}
          </Button>
        )}

        {stage === 'ready' && physical && (
          <PhysicalEntry
            inputRef={inputRef}
            instructions={physicalInstructions(request, expression)}
            label={kind === 'd20' ? 'Your d20' : 'Your total'}
            d20={kind === 'd20'}
            onSubmit={submitManual}
            onEdit={() => setError(null)}
          />
        )}

        {stage === 'result' && result && (
          <div className="flex w-full gap-2">
            {manual && (
              <Button variant="ghost" onClick={() => setStage('ready')}>
                Change
              </Button>
            )}
            <Button
              ref={primaryRef}
              variant="primary"
              size="lg"
              className="flex-1"
              onClick={() => finish(result, manual)}
            >
              Continue
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** The d20 (tumbling while rolling) or, for damage dice, the total in a tile. */
function RollFace({
  stage,
  kind,
  result,
  request,
}: {
  stage: Stage;
  kind: 'd20' | 'dice';
  result: D20TestResult | null;
  request: RollInteraction['request'];
}) {
  const tick = useTumble(stage === 'rolling');
  const badges = result && stage === 'result' ? outcomeBadges(result, request.rollType === 'attack') : [];
  const tone = stage === 'result' ? primaryTone(request.revealDc ? badges : badges.filter(isNatural)) : 'neutral';

  if (kind === 'dice') {
    return (
      <div
        className={cn(
          'grid size-24 place-items-center rounded-3xl border-2 border-current bg-surface-2 text-3xl font-bold tabular-nums',
          TONE_TEXT[tone],
        )}
        style={
          stage === 'rolling'
            ? { transform: `rotate(${tick * 47}deg)`, transition: 'transform 80ms linear' }
            : undefined
        }
        aria-hidden
      >
        {stage === 'result' && result ? (
          result.total
        ) : stage === 'rolling' ? (
          ((tick * 7) % 12) + 1
        ) : (
          <Dices className="size-9" />
        )}
      </div>
    );
  }
  const face =
    stage === 'result' && result?.natural !== undefined
      ? result.natural
      : stage === 'rolling'
        ? ((tick * 7 + 3) % 20) + 1
        : '?';
  return (
    <div
      aria-hidden
      style={
        stage === 'rolling'
          ? { transform: `rotate(${tick * 53}deg) scale(0.92)`, transition: 'transform 80ms linear' }
          : undefined
      }
      className={cn(stage === 'ready' && 'opacity-60')}
    >
      <D20Face value={face} className={cn('size-24', TONE_TEXT[tone])} />
    </div>
  );
}

function isNatural(badge: OutcomeBadge): boolean {
  return badge.label.startsWith('Natural') || badge.label.startsWith('Critical');
}

/** A counter that ticks while `active`, driving the cosmetic tumble (no game randomness). */
function useTumble(active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 70);
    return () => window.clearInterval(id);
  }, [active]);
  return tick;
}

function RollResultSummary({
  result,
  kind,
  attack,
  showOutcome,
  deathSave,
}: {
  result: D20TestResult;
  kind: 'd20' | 'dice';
  attack: boolean;
  showOutcome: boolean;
  deathSave: boolean;
}) {
  const all = outcomeBadges(result, attack);
  // With a hidden DC the player sees natural 20s and 1s, not whether they beat the DC.
  const badges = (showOutcome ? all : all.filter(isNatural)).map((b) => (deathSave ? deathSaveBadge(b) : b));
  const dropped = result.dice.filter((d) => d.sides === 20 && d.dropped);
  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-2xl font-semibold tabular-nums">
        <span className="sr-only">You rolled </span>
        {kind === 'd20' && result.natural !== undefined ? (
          <>
            {result.natural}
            {dropped.map((d, i) => (
              <s key={i} className="ml-2 text-lg font-normal text-faint">
                <span className="sr-only">(dropped </span>
                {d.value}
                <span className="sr-only">)</span>
              </s>
            ))}
            {joinedModifier(result.modifier)} = {result.total}
          </>
        ) : (
          result.total
        )}
      </p>
      {kind === 'dice' && result.dice.length > 0 && (
        <p className="text-xs text-muted">
          Dice: {result.dice.map((d) => d.value).join(', ')}
          {result.modifier ? ` ${signed(result.modifier)}` : ''}
        </p>
      )}
      {badges.length > 0 && (
        <div className="flex flex-wrap justify-center gap-1.5">
          {badges.map((b) => (
            <Badge key={b.label} tone={b.tone === 'neutral' ? 'neutral' : b.tone} className="px-2.5 py-1 text-sm">
              {b.label}
            </Badge>
          ))}
        </div>
      )}
      {!showOutcome && kind === 'd20' && <p className="text-xs text-muted">The DM will tell you how it goes.</p>}
    </div>
  );
}

function announceResult(result: D20TestResult, kind: 'd20' | 'dice', showOutcome: boolean, attack: boolean): string {
  const badges = outcomeBadges(result, attack).filter((b) => showOutcome || isNatural(b));
  const rolled =
    kind === 'd20' && result.natural !== undefined
      ? `Rolled ${result.natural}, total ${result.total}.`
      : `Total ${result.total}.`;
  return [rolled, ...badges.map((b) => `${b.label}.`)].join(' ');
}

function deathSaveBadge(badge: OutcomeBadge): OutcomeBadge {
  if (badge.label === 'Natural 20') return { ...badge, label: 'Natural 20: you regain 1 HP' };
  if (badge.label === 'Natural 1') return { ...badge, label: 'Natural 1: two failures' };
  return badge;
}

function PhysicalEntry({
  inputRef,
  instructions,
  label,
  d20,
  onSubmit,
  onEdit,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  instructions: string;
  label: string;
  d20: boolean;
  onSubmit: (value: string) => void;
  onEdit: () => void;
}) {
  const [value, setValue] = useState('');
  const inputId = useId();
  const hintId = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(value);
  };
  return (
    // noValidate: our own messages (role="alert") explain out-of-range values.
    <form onSubmit={submit} noValidate className="flex w-full flex-col gap-3">
      <p
        id={hintId}
        className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-left text-sm text-muted"
      >
        <Hand className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
        {instructions}
      </p>
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1 text-left">
          <label htmlFor={inputId} className="text-sm font-medium">
            {label}
          </label>
          <Input
            ref={inputRef}
            id={inputId}
            type="number"
            inputMode="numeric"
            min={d20 ? 1 : undefined}
            max={d20 ? 20 : undefined}
            step={1}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              onEdit();
            }}
            aria-describedby={hintId}
            className="h-12 text-center text-xl font-semibold tabular-nums"
          />
        </div>
        <Button type="submit" variant="primary" size="lg">
          Use this roll
        </Button>
      </div>
    </form>
  );
}
