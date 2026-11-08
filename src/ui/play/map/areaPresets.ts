/**
 * Area-template presets (D64): the hero's prepared spells whose compendium text names an area — parsed with
 * parseAreaText (the text is the source of truth: only a few SRD spells carry `data.area`, and Lightning Bolt's
 * stored size is its width), `data.area` only as a fallback — plus the Custom sizes. Pure.
 */
import { parseAreaText } from '@/engine';
import type { RulesIndex } from '@/data';
import type { AreaShape, Character, CompendiumEntry } from '@/types';

export type TemplateShape = Exclude<AreaShape, 'squares'>;

export interface AreaPreset {
  /** A spell id, or "custom". */
  id: string;
  label: string;
  shape: TemplateShape;
  sizeFt: number;
  widthFt?: number;
  heightFt?: number;
  /** The spell's range in feet; undefined for Self and Touch. */
  rangeFt?: number;
  /** It comes out of the hero's space (cones, lines, emanations, a cube "originating from you"). */
  fromSelf: boolean;
}

export const TEMPLATE_SHAPES: readonly TemplateShape[] = ['sphere', 'cylinder', 'cone', 'line', 'cube', 'emanation'];
export const SHAPE_LABEL: Readonly<Record<TemplateShape, string>> = {
  sphere: 'Sphere',
  cylinder: 'Cylinder',
  cone: 'Cone',
  line: 'Line',
  cube: 'Cube',
  emanation: 'Emanation',
};
/** The Custom size choices (spec §7.4), plus a number field for anything else. */
export const CUSTOM_SIZES: readonly number[] = [5, 10, 15, 20, 30, 40, 60, 100];

/** "150 feet" → 150, "60 ft." → 60; Self, Touch, Sight and the like → undefined. */
export function rangeFeet(range: unknown): number | undefined {
  if (typeof range !== 'string') return undefined;
  if (/^\s*(self|touch)\b/i.test(range)) return undefined;
  const m = /(\d[\d,]*)\s*(?:-\s*)?(?:feet|foot|ft)\b/i.exec(range);
  if (m) return Number(m[1].replace(/,/g, ''));
  const miles = /(\d+)\s*miles?\b/i.exec(range);
  return miles ? Number(miles[1]) * 5280 : undefined;
}

function isSelfRange(range: unknown): boolean {
  return typeof range === 'string' && /^\s*self\b/i.test(range);
}

const SHAPES = new Set<string>(TEMPLATE_SHAPES);

/** `data.area` ({ shape, size }) when the text names no area. */
function storedArea(entry: CompendiumEntry): { shape: TemplateShape; sizeFt: number } | null {
  const area = entry.data?.area as { shape?: unknown; size?: unknown } | undefined;
  if (!area || typeof area.shape !== 'string' || typeof area.size !== 'number') return null;
  const shape = area.shape.toLowerCase();
  if (!SHAPES.has(shape) || area.size < 5) return null;
  return { shape: shape as TemplateShape, sizeFt: Math.round(area.size / 5) * 5 };
}

/** The preset a spell entry describes, or null when it has no area. */
export function presetFromEntry(entry: CompendiumEntry, label = entry.name): AreaPreset | null {
  const parsed = parseAreaText(entry.text);
  const area = parsed && parsed.shape !== 'squares' && parsed.sizeFt ? parsed : storedArea(entry);
  if (!area || area.shape === 'squares' || !area.sizeFt) return null;
  const shape = area.shape as TemplateShape;
  const range = entry.data?.range;
  const fromSelf = shape === 'cone' || shape === 'line' || shape === 'emanation' || (shape === 'cube' && isSelfRange(range));
  return {
    id: entry.id,
    label,
    shape,
    sizeFt: area.sizeFt,
    ...('widthFt' in area && area.widthFt ? { widthFt: area.widthFt } : {}),
    ...('heightFt' in area && area.heightFt ? { heightFt: area.heightFt } : {}),
    ...(fromSelf ? {} : rangeFeet(range) !== undefined ? { rangeFt: rangeFeet(range) } : {}),
    fromSelf,
  };
}

/** "Your spells": prepared spells (and cantrips) with an area, in sheet order; [] while the rules index loads. */
export function spellPresets(character: Character, index: RulesIndex | null): AreaPreset[] {
  if (!index) return [];
  const out: AreaPreset[] = [];
  const seen = new Set<string>();
  for (const spell of character.spellcasting?.spells ?? []) {
    if (!spell.prepared && spell.level > 0) continue;
    if (seen.has(spell.id)) continue;
    seen.add(spell.id);
    const entry = index.get(spell.id);
    const preset = entry ? presetFromEntry(entry, spell.name) : null;
    if (preset) out.push(preset);
  }
  return out;
}

/** A Custom preset (the picker's shape, size, line width and an optional name: "Fireball", else "Sphere"). */
export function customPreset(shape: TemplateShape, sizeFt: number, widthFt?: number, name?: string): AreaPreset {
  const size = Math.max(5, Math.round(sizeFt / 5) * 5);
  return {
    id: 'custom',
    label: name?.replace(/[[\]\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || SHAPE_LABEL[shape],
    shape,
    sizeFt: size,
    ...(shape === 'line' ? { widthFt: Math.max(5, Math.round((widthFt ?? 5) / 5) * 5) } : {}),
    fromSelf: shape === 'cone' || shape === 'line' || shape === 'emanation',
  };
}
