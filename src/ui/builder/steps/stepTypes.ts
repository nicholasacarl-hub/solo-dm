import type { Character } from '@/types';
import type { BuilderContext } from '../logic';
import type { BuilderDraft, BuilderStep } from '../types';

export type DraftUpdate = BuilderDraft | ((d: BuilderDraft) => BuilderDraft);

export interface StepProps {
  draft: BuilderDraft;
  setDraft: (next: DraftUpdate) => void;
  ctx: BuilderContext;
  /** "Let the DM decide" for this step. */
  onDmDecide: () => void;
  /** The character as built from the current draft (null if it can't be built yet). */
  built: Character | null;
  /** Jump to another step (Review's "Fix" links). */
  goTo: (step: BuilderStep) => void;
}
