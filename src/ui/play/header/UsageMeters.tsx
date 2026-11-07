import { useId } from 'react';
import { Cpu } from 'lucide-react';
import { Popover } from '../components/Popover';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '@/lib/cn';
import { useGame } from '@/state/gameStore';
import { useSettings } from '@/state/settingsStore';
import { formatTokens, formatUsd, modelLabel } from '../format';

/** How full this session's context is, against the soft limit in Settings. */
export function ContextMeter({ className, showLabel = true }: { className?: string; showLabel?: boolean }) {
  const used = useGame((s) => s.activeSession?.contextTokens ?? 0);
  const limit = useSettings((s) => s.sessionSoftLimitTokens);
  const labelId = useId();
  const ratio = limit > 0 ? used / limit : 0;
  const over = ratio >= 1;
  const tone = over ? 'bg-danger' : ratio >= 0.8 ? 'bg-gold' : 'bg-accent';
  const title = over
    ? 'This session is past its context soft limit. Consider ending the session: the next one starts fresh with a recap.'
    : "How much of the session's context soft limit is used. Long sessions cost more per turn.";
  return (
    <div className={cn('flex items-center gap-2', className)} title={title}>
      <span id={labelId} className={cn('text-xs text-muted', !showLabel && 'sr-only')}>
        Context
      </span>
      <div
        role="meter"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
        aria-valuetext={`${formatTokens(used)} of ${formatTokens(limit)} tokens${over ? ', past the soft limit' : ''}`}
        className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-3"
      >
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
      <span className={cn('text-xs tabular-nums', over ? 'font-medium text-danger' : 'text-faint')}>
        {formatTokens(used)}/{formatTokens(limit)}
      </span>
    </div>
  );
}

/** Estimated spend (published prices, not a bill): this session and the whole campaign. */
export function CostReadout({ className }: { className?: string }) {
  const { session, campaign } = useGame(
    useShallow((s) => ({
      session: s.activeSession?.usage.estimatedCostUsd ?? null,
      campaign: s.campaign?.usage.estimatedCostUsd ?? 0,
    })),
  );
  return (
    <p
      className={cn('text-xs whitespace-nowrap text-muted tabular-nums', className)}
      title="Estimated from published per-token prices; not a bill."
    >
      {session !== null && (
        <>
          <span className="text-text">{formatUsd(session)}</span> session
          <span aria-hidden> · </span>
          <span className="sr-only">, </span>
        </>
      )}
      <span className="text-text">{formatUsd(campaign)}</span> campaign
    </p>
  );
}

/** The model this session runs on (sessions keep their model; otherwise the Settings choice). */
export function ModelReadout({ className }: { className?: string }) {
  const sessionModel = useGame((s) => s.activeSession?.model ?? null);
  const settingsModel = useSettings((s) => s.model);
  const model = sessionModel ?? settingsModel;
  return (
    <p className={cn('flex items-center gap-1 text-xs whitespace-nowrap text-muted', className)} title={`Model: ${model}`}>
      <Cpu className="size-3.5" aria-hidden />
      <span className="sr-only">Model: </span>
      {modelLabel(model)}
    </p>
  );
}

/**
 * Desktop header: one compact pill (context meter, session cost, model) that opens the full
 * breakdown, including the campaign total.
 */
export function UsagePill() {
  const used = useGame((s) => s.activeSession?.contextTokens ?? 0);
  const sessionCost = useGame((s) => s.activeSession?.usage.estimatedCostUsd ?? null);
  const campaignCost = useGame((s) => s.campaign?.usage.estimatedCostUsd ?? 0);
  const sessionModel = useGame((s) => s.activeSession?.model ?? null);
  const settingsModel = useSettings((s) => s.model);
  const limit = useSettings((s) => s.sessionSoftLimitTokens);
  const ratio = limit > 0 ? used / limit : 0;
  const over = ratio >= 1;
  const model = modelLabel(sessionModel ?? settingsModel);
  const cost = sessionCost ?? campaignCost;
  const label =
    `Usage: context ${formatTokens(used)} of ${formatTokens(limit)} tokens, ` +
    `${sessionCost !== null ? `${formatUsd(sessionCost)} this session, ` : ''}${formatUsd(campaignCost)} campaign, model ${model}`;

  return (
    <Popover
      label="Usage"
      placement="bottom-end"
      className="w-72"
      trigger={({ ref, ...props }) => (
        <button
          ref={ref}
          type="button"
          {...props}
          aria-label={label}
          title="Context, estimated cost and model"
          className="flex h-9 items-center gap-2.5 rounded-xl border border-border px-3 text-xs whitespace-nowrap text-muted transition-colors hover:bg-surface-2 hover:text-text aria-expanded:bg-surface-2"
        >
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-10 overflow-hidden rounded-full bg-surface-3" aria-hidden>
              <span
                className={cn('block h-full rounded-full', over ? 'bg-danger' : ratio >= 0.8 ? 'bg-gold' : 'bg-accent')}
                style={{ width: `${Math.min(100, ratio * 100)}%` }}
              />
            </span>
            <span className={cn('tabular-nums', over && 'font-medium text-danger')}>{formatTokens(used)}</span>
          </span>
          <span className="h-3.5 w-px bg-border" aria-hidden />
          <span className="text-text tabular-nums">{formatUsd(cost)}</span>
          <span className="h-3.5 w-px bg-border" aria-hidden />
          <span>{model}</span>
        </button>
      )}
    >
      <div className="flex flex-col gap-3">
        <ContextMeter />
        <CostReadout />
        <ModelReadout />
        <p className="text-xs text-faint">
          Costs are estimated from published prices, not a bill. When the context passes the soft limit, end the
          session: the next one starts fresh from a recap.
        </p>
      </div>
    </Popover>
  );
}
