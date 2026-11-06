/**
 * PLACEHOLDER — implemented by the shell-UI module.
 * The "table rules" form (tone, setting, fidelity, homebrew, difficulty, narration, roll mode,
 * leveling, DM rolls, safety lines & veils). Used by the New Campaign wizard and by the Play
 * screen's "Table rules" dialog.
 */
import type { CampaignSettings } from '@/types';

export interface CampaignSettingsFormProps {
  value: CampaignSettings;
  onChange: (next: CampaignSettings) => void;
  /** Which groups to show; default all. */
  sections?: Array<'story' | 'rules' | 'safety'>;
}

export function CampaignSettingsForm(_props: CampaignSettingsFormProps) {
  return null;
}
