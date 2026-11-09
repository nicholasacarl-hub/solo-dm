/**
 * Merged builder data (spec §5.1, pure): accepted option records → builder options (ids = publicId,
 * descriptions = the book's words via featureText, a ref on every copied text), attached to the SRD
 * without mutating it (an SRD class that gains subclasses is shallow-cloned once).
 *
 * CONTRACT (Day 0 stub). Owner: E4.
 */
import type {
  BackgroundOption,
  BuilderData,
  ClassOption,
  EquipmentOption,
  FeatOption,
  SpeciesOption,
  StructuredKind,
  SubclassOption,
} from '@/types';
import type { LibrarySnapshot } from '../rulesIndexStore';

export interface MergeProblem { recordId: string; sourceTitle: string; kind: StructuredKind; name: string; message: string }
export interface ImportedOptions {
  classes: ClassOption[];
  subclasses: { option: SubclassOption; parentClassId: string }[];
  species: SpeciesOption[]; backgrounds: BackgroundOption[]; feats: FeatOption[]; equipment: EquipmentOption[];
  problems: MergeProblem[];
}

export function importedOptions(snapshot: LibrarySnapshot): ImportedOptions {
  void snapshot;
  // not implemented (Day-0 stub): safe default = no imported options
  return { classes: [], subclasses: [], species: [], backgrounds: [], feats: [], equipment: [], problems: [] };
}

/** Never mutates `srd` (the cached builder.json object); an SRD class that gains subclasses is shallow-cloned once. */
export function mergeBuilderData(srd: BuilderData, imported: ImportedOptions): { data: BuilderData; problems: MergeProblem[] } {
  void imported;
  return { data: srd, problems: [] }; // not implemented (Day-0 stub): safe default = the no-imports identity
}
