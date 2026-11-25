// @vitest-environment node
/**
 * Text on the solid colour fills reaches WCAG 2.2 AA for normal-size text (SC 1.4.3: 4.5:1) in both themes, at
 * rest and on hover. A `--X-ink` token in src/index.css is the text colour for its `bg-X` fill (`text-X-ink`). The
 * colours are read from the stylesheet itself, so a palette change that breaks a pair fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

/** The custom properties a top-level rule of index.css declares, by name without the leading dashes. */
function declared(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`^${escaped} \\{([^}]*)\\}`, 'm').exec(CSS)?.[1] ?? '';
  const tokens = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
  if (Object.keys(tokens).length === 0) throw new Error(`index.css has no top-level ${selector} rule with custom properties`);
  return tokens;
}

const light = declared(':root');
/** <html data-theme="dark"> overrides the light tokens. */
const THEMES = { light, dark: { ...light, ...declared("[data-theme='dark']") } };

type Rgb = number[];

function colour(theme: Record<string, string>, token: string): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(theme[token] ?? '')?.[1];
  if (!hex) throw new Error(`--${token} is not a #rrggbb colour: ${theme[token]}`);
  const n = parseInt(hex, 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

/** WCAG 2.2 relative luminance. */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.2 contrast ratio, from 1 to 21. */
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `top` at `alpha` over `under`, as the browser composites `opacity`. */
const over = (top: Rgb, under: Rgb, alpha: number): Rgb => top.map((c, i) => c * alpha + under[i] * (1 - alpha));

/**
 * The solid fills that carry text or icons: the Button and ButtonLink variants (src/ui/components), the sheet's Heal
 * button, the inventory's "Remove?" and the builder's done steps. `hover` is another fill under the same ink;
 * `hoverOpacity` fades the whole button, text and fill alike, over the surface it sits on.
 */
interface Fill {
  fill: string;
  ink: string;
  hover?: string;
  hoverOpacity?: number;
}
const FILLS: Fill[] = [
  { fill: 'accent', ink: 'accent-ink', hover: 'accent-hover' }, // primary: bg-accent text-accent-ink hover:bg-accent-hover
  { fill: 'arcane', ink: 'arcane-ink', hoverOpacity: 0.9 }, // arcane: bg-arcane text-arcane-ink hover:opacity-90
  { fill: 'danger', ink: 'danger-ink', hoverOpacity: 0.9 }, // danger (hover:opacity-90), the inventory's "Remove?"
  { fill: 'success', ink: 'success-ink', hoverOpacity: 0.9 }, // Heal (hover:opacity-90), the builder's done steps
];
/** The surfaces a button sits on. */
const SURFACES = ['bg', 'surface', 'surface-2', 'surface-3'];
const AA = 4.5;

describe.each(Object.entries(THEMES))('the %s theme', (_name, theme) => {
  it.each(FILLS)('text-$ink on bg-$fill', ({ fill, ink, hover, hoverOpacity }) => {
    const text = colour(theme, ink);
    expect(contrast(text, colour(theme, fill)), 'at rest').toBeGreaterThanOrEqual(AA);
    if (hover) expect(contrast(text, colour(theme, hover)), `on ${hover}`).toBeGreaterThanOrEqual(AA);
    if (hoverOpacity) {
      for (const surface of SURFACES) {
        const under = colour(theme, surface);
        const ratio = contrast(over(text, under, hoverOpacity), over(colour(theme, fill), under, hoverOpacity));
        expect(ratio, `hovered, over ${surface}`).toBeGreaterThanOrEqual(AA);
      }
    }
  });
});
