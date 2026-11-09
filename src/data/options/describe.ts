/**
 * App-written item descriptions (spec §6.6): "Rare armor (Chain Mail), requires attunement · +1 AC".
 * Copies of imported items carry these numbers-only descriptions, never the book's text.
 *
 * CONTRACT (Day 0 stub). Owner: E4.
 */
import type { EquipmentOption } from '@/types';

export function describeOption(option: EquipmentOption): string {
  void option;
  return ''; // not implemented (Day-0 stub): safe default
}
