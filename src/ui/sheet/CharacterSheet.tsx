/**
 * PLACEHOLDER — implemented by the character-UI module.
 * Full or compact character sheet. With editable, player edits go through useGame().updateCharacter
 * and queue a DM notice describing the change.
 */
import type { Character } from '@/types';

export interface CharacterSheetProps {
  character: Character;
  /** 'full' = tabs for everything (Play right rail / Sheet tab); 'compact' = vitals summary card. */
  variant?: 'full' | 'compact';
  editable?: boolean;
}

export function CharacterSheet({ character }: CharacterSheetProps) {
  return <div className="p-4 text-sm text-muted">Character sheet for {character.name} (placeholder)</div>;
}
