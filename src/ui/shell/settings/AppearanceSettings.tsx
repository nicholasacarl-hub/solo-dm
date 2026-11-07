/** Settings: theme, narration font and size, dice animations; and the offline demo DM. */
import { useShallow } from 'zustand/react/shallow';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useSettings } from '@/state/settingsStore';
import type { AppSettings } from '@/types';
import { Switch } from '@/ui/components/ui';
import { SegmentedField, type SegmentOption } from '@/ui/components/OptionCards';

const THEME_OPTIONS: readonly SegmentOption<AppSettings['theme']>[] = [
  { value: 'system', label: <><Monitor className="size-4" aria-hidden />System</> },
  { value: 'dark', label: <><Moon className="size-4" aria-hidden />Dark</> },
  { value: 'light', label: <><Sun className="size-4" aria-hidden />Light</> },
];

const FONT_OPTIONS: readonly SegmentOption<AppSettings['narrationFont']>[] = [
  { value: 'serif', label: 'Serif' },
  { value: 'sans', label: 'Sans-serif' },
];

const SIZE_OPTIONS: readonly SegmentOption<AppSettings['textSize']>[] = [
  { value: 'sm', label: 'Small' },
  { value: 'md', label: 'Medium' },
  { value: 'lg', label: 'Large' },
];

export function AppearanceSettings() {
  const { theme, narrationFont, textSize, diceAnimations, update } = useSettings(
    useShallow((s) => ({
      theme: s.theme,
      narrationFont: s.narrationFont,
      textSize: s.textSize,
      diceAnimations: s.diceAnimations,
      update: s.update,
    })),
  );
  return (
    <>
      <SegmentedField
        legend="Theme"
        hint="System follows your device’s light or dark mode."
        value={theme}
        options={THEME_OPTIONS}
        onChange={(next) => update({ theme: next })}
      />
      <div className="flex flex-col gap-5 sm:flex-row sm:gap-8">
        <SegmentedField
          legend="Narration font"
          value={narrationFont}
          options={FONT_OPTIONS}
          onChange={(next) => update({ narrationFont: next })}
        />
        <SegmentedField
          legend="Text size"
          value={textSize}
          options={SIZE_OPTIONS}
          onChange={(next) => update({ textSize: next })}
        />
      </div>
      <figure className="rounded-xl border border-border bg-surface-2 px-4 py-3">
        <figcaption className="mb-1 text-xs text-muted">Preview</figcaption>
        <p className={cn('narration', narrationFont === 'serif' && 'narration-serif')}>
          The lantern gutters as the door groans open. Somewhere below, water drips onto stone, slow and patient,
          like something counting.
        </p>
      </figure>
      <Switch
        checked={diceAnimations}
        onChange={(next) => update({ diceAnimations: next })}
        label="Dice animations"
        description="Tumble the dice on screen. Off: results appear instantly."
      />
    </>
  );
}

export function DemoSettings() {
  const mockMode = useSettings((s) => s.mockMode);
  const update = useSettings((s) => s.update);
  return (
    <Switch
      checked={mockMode}
      onChange={(next) => update({ mockMode: next })}
      label="Demo DM"
      description="An offline, scripted DM for trying the app without an API key. It makes no API calls and can’t truly improvise."
    />
  );
}
