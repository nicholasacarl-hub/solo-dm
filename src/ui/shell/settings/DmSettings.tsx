/** Settings: how Claude runs the table (model, effort, thinking display, caching, session length). */
import { useId } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { TriangleAlert } from 'lucide-react';
import { useSettings } from '@/state/settingsStore';
import { MODELS, type AppSettings, type Effort, type ThinkingDisplay } from '@/types';
import { Badge } from '@/ui/components/ui';
import { OptionCards, type OptionCardOption } from '@/ui/components/OptionCards';
import { formatTokens, formatUsd } from '../format';
import { StatusLine } from './SettingsSection';

const EFFORT_OPTIONS: readonly OptionCardOption<Effort>[] = [
  { value: 'low', label: 'Low', description: 'Quickest replies and lowest cost, with lighter planning.' },
  {
    value: 'medium',
    label: 'Medium',
    description: 'Careful rulings and plotting without long waits.',
    aside: <Badge tone="accent">Recommended</Badge>,
  },
  { value: 'high', label: 'High', description: 'Deepest thinking for tricky rules and twisty plots. Slower, costs more.' },
];

const THINKING_OPTIONS: readonly OptionCardOption<ThinkingDisplay>[] = [
  { value: 'omitted', label: 'Hidden', description: 'Just the story. The DM thinks in private.' },
  { value: 'updates', label: 'Progress notes', description: 'Short notes on what the DM is doing between steps.' },
  { value: 'summarized', label: 'Reasoning summaries', description: 'Summaries of the DM’s reasoning, for the curious.' },
];

const CACHE_OPTIONS: readonly OptionCardOption<AppSettings['cacheTtl']>[] = [
  { value: '5m', label: '5 minutes', description: 'Cheapest when you reply within a few minutes.' },
  { value: '1h', label: '1 hour', description: 'Suits slower play: pauses between turns stay cheap.' },
];

const SOFT_LIMIT = { min: 50_000, max: 400_000, step: 10_000 };

function ratio(value: number, base: number): string {
  if (base <= 0) return '';
  const r = value / base;
  return `${Number.isInteger(r) ? r : r.toFixed(2).replace(/0$/, '')}×`;
}

export function DmSettings() {
  const id = useId();
  const { model, effort, thinkingDisplay, cacheTtl, sessionSoftLimitTokens, update } = useSettings(
    useShallow((s) => ({
      model: s.model,
      effort: s.effort,
      thinkingDisplay: s.thinkingDisplay,
      cacheTtl: s.cacheTtl,
      sessionSoftLimitTokens: s.sessionSoftLimitTokens,
      update: s.update,
    })),
  );
  const info = MODELS.find((m) => m.id === model) ?? MODELS[0];
  const { pricing } = info;

  const modelOptions: OptionCardOption<string>[] = MODELS.map((m) => ({
    value: m.id,
    label: m.label,
    description: m.blurb,
    aside: (
      <span className="text-xs whitespace-nowrap text-muted tabular-nums">
        {formatUsd(m.pricing.input)} in · {formatUsd(m.pricing.output)} out
      </span>
    ),
  }));

  return (
    <>
      <OptionCards
        legend="Model"
        hint="Prices are US dollars per million tokens. The default is Claude Opus 5.5."
        value={model}
        options={modelOptions}
        onChange={(next) => update({ model: next })}
      />
      {!MODELS.some((m) => m.id === model) && (
        <StatusLine tone="gold" icon={<TriangleAlert className="size-4" aria-hidden />}>
          Using a custom model id: {model}
        </StatusLine>
      )}

      <OptionCards
        legend="Effort"
        hint="How hard the DM thinks before it answers."
        columns={3}
        value={effort}
        options={EFFORT_OPTIONS}
        onChange={(next) => update({ effort: next })}
      />

      <div className="flex flex-col gap-2">
        <OptionCards
          legend="Thinking display"
          hint="What you see of the DM’s thinking during play."
          columns={3}
          value={thinkingDisplay}
          options={THINKING_OPTIONS}
          onChange={(next) => update({ thinkingDisplay: next })}
        />
        {thinkingDisplay === 'summarized' && (
          <StatusLine tone="gold" icon={<TriangleAlert className="size-4" aria-hidden />}>
            Reasoning summaries can spoil secrets: hidden rolls, an NPC’s true motives, the twist the DM is planning.
          </StatusLine>
        )}
      </div>

      <OptionCards
        legend="Prompt cache"
        hint={`Each turn re-reads your campaign from Anthropic’s cache at a discount. Writing the cache costs ${ratio(pricing.cacheWrite5m, pricing.input)} the input price for 5 minutes, ${ratio(pricing.cacheWrite1h, pricing.input)} for 1 hour.`}
        columns={2}
        value={cacheTtl}
        options={CACHE_OPTIONS}
        onChange={(next) => update({ cacheTtl: next })}
      />

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={`${id}-limit`} className="text-sm font-medium">
            Session length
          </label>
          <output htmlFor={`${id}-limit`} className="text-sm text-muted tabular-nums">
            {formatTokens(sessionSoftLimitTokens)} tokens
          </output>
        </div>
        <input
          id={`${id}-limit`}
          type="range"
          min={SOFT_LIMIT.min}
          max={SOFT_LIMIT.max}
          step={SOFT_LIMIT.step}
          value={sessionSoftLimitTokens}
          aria-valuetext={`${formatTokens(sessionSoftLimitTokens)} tokens`}
          aria-describedby={`${id}-limit-hint`}
          onChange={(e) => update({ sessionSoftLimitTokens: Number(e.target.value) })}
          className="w-full accent-accent"
        />
        <div aria-hidden className="flex justify-between text-[11px] text-faint">
          <span>{formatTokens(SOFT_LIMIT.min)}</span>
          <span>{formatTokens(SOFT_LIMIT.max)}</span>
        </div>
        <p id={`${id}-limit-hint`} className="text-xs text-muted">
          When a session’s conversation reaches this size, the DM suggests wrapping up with a recap. Longer sessions
          keep more detail in view, but every turn costs a little more.
        </p>
      </div>
    </>
  );
}
