/**
 * Area-template presets (D64): the hero's prepared spells whose compendium text names an area — parsed with
 * parseAreaText (the text is the source of truth: only a few SRD spells carry `data.area`, and Lightning Bolt's
 * stored size is its width), `data.area` only as a fallback — plus the Custom sizes. A spell the player
 * reviewed from their own book (structured imports, spec §6.4) is the exception: its `data.area` is the
 * player's checked reading, so it comes first. Pure.
 */
import { parseAreaText } from '@/engine';
import type { RulesIndex } from '@/data';
import { isReviewedImport } from '@/data/structured/materialize';
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

interface StoredArea {
  shape: TemplateShape;
  sizeFt: number;
  widthFt?: number;
  heightFt?: number;
}

/** A stored length in feet, on the 5-foot grid; undefined when absent or not a usable number. */
function feet(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 5 ? Math.round(value / 5) * 5 : undefined;
}

/** `data.area` ({ shape, size, widthFt?, heightFt? }: a reviewed import's, or the SRD's when the text names no area). */
function storedArea(entry: CompendiumEntry): StoredArea | null {
  const area = entry.data?.area as { shape?: unknown; size?: unknown; widthFt?: unknown; heightFt?: unknown } | undefined;
  if (!area || typeof area.shape !== 'string') return null;
  const shape = area.shape.toLowerCase();
  const sizeFt = feet(area.size);
  if (!SHAPES.has(shape) || sizeFt === undefined) return null;
  const widthFt = feet(area.widthFt);
  const heightFt = feet(area.heightFt);
  return { shape: shape as TemplateShape, sizeFt, ...(widthFt ? { widthFt } : {}), ...(heightFt ? { heightFt } : {}) };
}

/** The text's area (parseAreaText), when it names one with a size. */
function textArea(entry: CompendiumEntry): StoredArea | null {
  const parsed = parseAreaText(entry.text);
  if (!parsed || parsed.shape === 'squares' || !parsed.sizeFt) return null;
  return {
    shape: parsed.shape as TemplateShape,
    sizeFt: parsed.sizeFt,
    ...('widthFt' in parsed && parsed.widthFt ? { widthFt: parsed.widthFt } : {}),
    ...('heightFt' in parsed && parsed.heightFt ? { heightFt: parsed.heightFt } : {}),
  };
}

/** The preset a spell entry describes, or null when it has no area. */
export function presetFromEntry(entry: CompendiumEntry, label = entry.name): AreaPreset | null {
  // A reviewed import's fields first (the player's correction wins); else the text, else the stored area.
  const area = (isReviewedImport(entry) ? storedArea(entry) : null) ?? textArea(entry) ?? storedArea(entry);
  if (!area) return null;
  const shape = area.shape as TemplateShape;
  const range = entry.data?.range;
  const fromSelf = shape === 'cone' || shape === 'line' || shape === 'emanation' || (shape === 'cube' && isSelfRange(range));
  return {
    id: entry.id,
    label,
    shape,
    sizeFt: area.sizeFt,
    ...(area.widthFt ? { widthFt: area.widthFt } : {}),
    ...(area.heightFt ? { heightFt: area.heightFt } : {}),
    ...(fromSelf ? {} : rangeFeet(range) !== undefined ? { rangeFt: rangeFeet(range) } : {}),
    fromSelf,
  };
}

/**
 * "Your spells": prepared spells (and cantrips) with an area, in sheet order; [] while the rules index loads.
 * A spell whose id the index doesn't know (the DM added it, or another device made the id) is found by name.
 */
export function spellPresets(character: Character, index: RulesIndex | null): AreaPreset[] {
  if (!index) return [];
  const out: AreaPreset[] = [];
  const seen = new Set<string>();
  for (const spell of character.spellcasting?.spells ?? []) {
    if (!spell.prepared && spell.level > 0) continue;
    if (seen.has(spell.id)) continue;
    seen.add(spell.id);
    const entry = index.get(spell.id) ?? index.findByName(spell.name, { kind: 'spell', campaignId: character.campaignId });
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
