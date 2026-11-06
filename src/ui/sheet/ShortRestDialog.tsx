/**
 * PLACEHOLDER — implemented by the character-UI module.
 * Lets the player choose hit dice to spend during a short rest (the DM's take_rest tool waits on it).
 */
import type { InteractionRequest, ShortRestResponse } from '@/types';

export interface ShortRestDialogProps {
  request: Extract<InteractionRequest, { kind: 'short-rest' }>;
  onDone: (response: ShortRestResponse) => void;
  onCancel: () => void;
}

export function ShortRestDialog(_props: ShortRestDialogProps) {
  return null;
}
