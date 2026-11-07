import { useId } from 'react';
import { Cloud, CloudFog, CloudLightning, CloudRain, Clock, Drama, MapPin, Moon, Snowflake, Sun, Sunrise, Sunset, Wind } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '@/lib/cn';
import { useGame } from '@/state/gameStore';

function timeIcon(time: string) {
  const t = time.toLowerCase();
  if (/dawn|sunrise|daybreak/.test(t)) return Sunrise;
  if (/dusk|sunset|evening|twilight/.test(t)) return Sunset;
  if (/night|midnight|dark/.test(t)) return Moon;
  if (/morning|noon|day|afternoon/.test(t)) return Sun;
  return Clock;
}

function weatherIcon(weather: string) {
  const w = weather.toLowerCase();
  if (/fog|mist|haze/.test(w)) return CloudFog;
  if (/storm|thunder|lightning/.test(w)) return CloudLightning;
  if (/rain|drizzle|shower/.test(w)) return CloudRain;
  if (/snow|sleet|frost|ice/.test(w)) return Snowflake;
  if (/wind|gale|breez/.test(w)) return Wind;
  if (/clear|sun|bright/.test(w)) return Sun;
  return Cloud;
}

export function tensionWord(tension: number): string {
  if (tension <= 2) return 'Calm';
  if (tension <= 4) return 'Steady';
  if (tension <= 6) return 'On edge';
  if (tension <= 8) return 'Volatile';
  return 'Chaos';
}

function segmentTone(segment: number): string {
  if (segment <= 3) return 'bg-info';
  if (segment <= 6) return 'bg-gold';
  return 'bg-danger';
}

/** Where the hero is: location, time, weather, mood and the solo-play tension dial. */
export function SceneCard({ className }: { className?: string }) {
  const { scene, tension } = useGame(
    useShallow((s) => ({ scene: s.campaign?.scene ?? null, tension: s.campaign?.tension ?? 5 })),
  );
  const titleId = useId();
  const tensionId = useId();
  if (!scene) return null;

  const level = Math.min(9, Math.max(1, Math.round(tension)));
  const subtitle = [scene.region, scene.inWorldDate].filter(Boolean).join(' · ');
  const TimeIcon = scene.timeOfDay ? timeIcon(scene.timeOfDay) : Clock;
  const WeatherIcon = scene.weather ? weatherIcon(scene.weather) : Cloud;

  return (
    <section aria-labelledby={titleId} className={cn('rounded-2xl border border-border bg-surface p-4 shadow-card', className)}>
      <p className="flex items-center gap-1.5 font-display text-[0.6875rem] font-semibold tracking-[0.16em] text-muted uppercase">
        <MapPin className="size-3.5 text-info" aria-hidden />
        Scene
      </p>
      <h2 id={titleId} className="mt-1.5 font-serif text-xl leading-snug font-semibold">
        {scene.location || 'Somewhere unknown'}
      </h2>
      {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}

      {(scene.timeOfDay || scene.weather || scene.mood) && (
        <dl className="mt-3 flex flex-col gap-1.5 text-sm">
          {scene.timeOfDay && (
            <div className="flex items-center gap-2">
              <dt className="sr-only">Time of day</dt>
              <TimeIcon className="size-4 shrink-0 text-faint" aria-hidden />
              <dd className="first-letter:uppercase">{scene.timeOfDay}</dd>
            </div>
          )}
          {scene.weather && (
            <div className="flex items-center gap-2">
              <dt className="sr-only">Weather</dt>
              <WeatherIcon className="size-4 shrink-0 text-faint" aria-hidden />
              <dd className="first-letter:uppercase">{scene.weather}</dd>
            </div>
          )}
          {scene.mood && (
            <div className="flex items-center gap-2">
              <dt className="sr-only">Mood</dt>
              <Drama className="size-4 shrink-0 text-faint" aria-hidden />
              <dd className="italic first-letter:uppercase">{scene.mood}</dd>
            </div>
          )}
        </dl>
      )}

      <div className="mt-4">
        <div className="flex items-baseline justify-between text-xs">
          <span id={tensionId} className="font-medium text-muted">
            Tension
          </span>
          <span className="text-faint tabular-nums">
            {level}/9 · {tensionWord(level)}
          </span>
        </div>
        <div
          role="meter"
          aria-labelledby={tensionId}
          aria-valuemin={1}
          aria-valuemax={9}
          aria-valuenow={level}
          aria-valuetext={`${level} of 9, ${tensionWord(level).toLowerCase()}`}
          className="mt-1.5 grid grid-cols-9 gap-1"
        >
          {Array.from({ length: 9 }, (_, i) => (
            <span key={i} className={cn('h-1.5 rounded-full', i < level ? segmentTone(i + 1) : 'bg-surface-3')} />
          ))}
        </div>
      </div>
    </section>
  );
}
