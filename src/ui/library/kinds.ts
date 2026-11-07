/** Display metadata for rules-content kinds (Library browse, homebrew lists). */
import {
  Award,
  Backpack,
  Footprints,
  Gem,
  Gift,
  HeartPulse,
  Layers,
  ScrollText,
  Shapes,
  Skull,
  Sparkles,
  Swords,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { invalidateRulesIndex } from '@/data';
import type { ContentKind } from '@/types';
import type { BadgeTone } from '@/ui/components/ui';

export interface KindInfo {
  label: string;
  plural: string;
  icon: LucideIcon;
  tone: BadgeTone;
}

export const KIND_INFO: Record<ContentKind, KindInfo> = {
  rule: { label: 'Rule', plural: 'Rules', icon: ScrollText, tone: 'neutral' },
  spell: { label: 'Spell', plural: 'Spells', icon: Sparkles, tone: 'arcane' },
  monster: { label: 'Monster', plural: 'Monsters', icon: Skull, tone: 'danger' },
  'magic-item': { label: 'Magic item', plural: 'Magic items', icon: Gem, tone: 'gold' },
  item: { label: 'Equipment', plural: 'Equipment', icon: Backpack, tone: 'neutral' },
  class: { label: 'Class', plural: 'Classes', icon: Swords, tone: 'accent' },
  subclass: { label: 'Subclass', plural: 'Subclasses', icon: Layers, tone: 'accent' },
  species: { label: 'Species', plural: 'Species', icon: Users, tone: 'info' },
  background: { label: 'Background', plural: 'Backgrounds', icon: Footprints, tone: 'info' },
  feat: { label: 'Feat', plural: 'Feats', icon: Award, tone: 'success' },
  condition: { label: 'Condition', plural: 'Conditions', icon: HeartPulse, tone: 'danger' },
  boon: { label: 'Boon', plural: 'Boons', icon: Gift, tone: 'gold' },
  other: { label: 'Other', plural: 'Other', icon: Shapes, tone: 'neutral' },
};

export const kindInfo = (kind: ContentKind): KindInfo => KIND_INFO[kind] ?? KIND_INFO.other;

/**
 * Drop the cached rules index after library or homebrew changes. Never throws: a failure here
 * must not undo a change that was already saved.
 */
export function refreshRulesIndex(): void {
  try {
    invalidateRulesIndex();
  } catch (error) {
    console.warn('[library] Could not refresh the rules index:', error);
  }
}
