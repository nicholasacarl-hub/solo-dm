/**
 * Starting equipment → inventory items and attacks (SRD 5.2.1 "Equipment").
 * Package item names are matched against the builder's equipment catalog.
 */
import type {
  Attack,
  EquipmentOption,
  EquipmentPackage,
  InventoryItem,
  ItemCategory,
} from '@/types';
import { newId, nameKey } from '@/lib/id';

/** SRD 5.2.1 Simple weapons (everything else in the catalog is Martial). */
const SIMPLE_WEAPONS = new Set(
  [
    'Club',
    'Dagger',
    'Greatclub',
    'Handaxe',
    'Javelin',
    'Light Hammer',
    'Mace',
    'Quarterstaff',
    'Sickle',
    'Spear',
    'Dart',
    'Light Crossbow',
    'Shortbow',
    'Sling',
  ].map(nameKey),
);

function singular(key: string): string {
  if (key.endsWith('ches') || key.endsWith('shes') || key.endsWith('sses')) return key.slice(0, -2);
  if (key.endsWith('ies')) return `${key.slice(0, -3)}y`;
  if (key.endsWith('s') && !key.endsWith('ss')) return key.slice(0, -1);
  return key;
}

export interface CatalogMatch {
  option: EquipmentOption;
  /** How the package named the item ("Arcane Focus" for "Arcane Focus (Quarterstaff)"). */
  via: 'name' | 'parenthetical' | 'base';
  /** The words outside the parentheses, when matched via the parenthetical. */
  base?: string;
}

/** Find a package item in the catalog: exact or singular name, then "(…)" contents, then the base name. */
export function findEquipment(name: string, catalog: EquipmentOption[]): CatalogMatch | null {
  const byKey = new Map<string, EquipmentOption>();
  for (const option of catalog) {
    const key = nameKey(option.name);
    byKey.set(key, option);
    byKey.set(singular(key), byKey.get(singular(key)) ?? option);
  }
  const lookup = (text: string) => byKey.get(nameKey(text)) ?? byKey.get(singular(nameKey(text)));
  const direct = lookup(name);
  if (direct) return { option: direct, via: 'name' };
  const paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(name);
  if (paren) {
    const inner = lookup(paren[2]);
    if (inner) return { option: inner, via: 'parenthetical', base: paren[1].trim() };
    const outer = lookup(paren[1]);
    if (outer) return { option: outer, via: 'base' };
  }
  return null;
}

export function isRangedWeapon(option: EquipmentOption): boolean {
  return (option.properties ?? []).some((p) => /^ammunition/i.test(p));
}

export function hasProperty(option: EquipmentOption, property: string): boolean {
  const key = property.toLowerCase();
  return (option.properties ?? []).some((p) => p.toLowerCase().startsWith(key));
}

export function weaponCategory(option: EquipmentOption): 'simple' | 'martial' {
  const hint = `${(option.properties ?? []).join(' ')} ${option.description ?? ''}`;
  if (/\bsimple\b/i.test(hint)) return 'simple';
  if (/\bmartial\b/i.test(hint)) return 'martial';
  return SIMPLE_WEAPONS.has(nameKey(option.name)) ? 'simple' : 'martial';
}

/**
 * Proficiency from class/feat proficiency strings: "Simple weapons", "Martial weapons",
 * "Martial weapons that have the Finesse or Light property", or a named weapon ("Longswords").
 */
export function isWeaponProficient(option: EquipmentOption, proficiencies: string[]): boolean {
  const category = weaponCategory(option);
  const key = nameKey(option.name);
  return proficiencies.some((prof) => {
    const lower = prof.toLowerCase();
    if (category === 'simple' && /\bsimple\b/.test(lower)) return true;
    if (category === 'martial' && /\bmartial\b/.test(lower)) {
      const limited = /martial weapons that have the (.+?) property/i.exec(prof);
      if (!limited) return true;
      return limited[1].split(/\s+or\s+/i).some((p) => hasProperty(option, p.trim()));
    }
    return singular(nameKey(prof)) === singular(key);
  });
}

/** Armor training from strings such as "Light armor", "Shields" or "Light and Medium armor and Shields". */
export function hasArmorTraining(option: EquipmentOption, training: string[]): boolean {
  const lower = training.map((t) => t.toLowerCase());
  if (option.category === 'shield') return lower.some((t) => t.includes('shield'));
  if (option.category !== 'armor' || !option.armorType) return false;
  const type = option.armorType;
  return lower.some((t) => t.includes(type) || t.includes('all armor'));
}

function itemCategory(option: EquipmentOption | undefined, name: string): ItemCategory {
  if (option) {
    if (option.category === 'pack') return 'gear';
    return option.category;
  }
  if (/potion|ration|oil|acid|alchemist's fire|antitoxin/i.test(name)) return 'consumable';
  if (/tools|supplies|kit|instrument|gaming set/i.test(name)) return 'tool';
  return 'gear';
}

function displayName(name: string, match: CatalogMatch | null): string {
  if (!match) return name;
  if (match.via === 'parenthetical' && match.base) return `${match.option.name} (${match.base.toLowerCase()})`;
  if (match.via === 'base') return name;
  return match.option.name;
}

/** Notable property text for an attack's notes: Versatile damage. */
function versatileNote(option: EquipmentOption): string | undefined {
  const versatile = (option.properties ?? []).find((p) => /^versatile/i.test(p));
  const dice = versatile && /\(([^)]+)\)/.exec(versatile)?.[1];
  return dice ? `Versatile: ${dice} two-handed` : undefined;
}

/** "5 ft.", "10 ft." (Reach), "80/320 ft." (ammunition) or "5 ft. or 20/60 ft. thrown". */
export function weaponRange(option: EquipmentOption): string {
  const rangeProp = (option.properties ?? []).find((p) => /range\s*\d+\s*\/\s*\d+/i.test(p));
  const range = rangeProp ? /(\d+)\s*\/\s*(\d+)/.exec(rangeProp) : null;
  const span = range ? `${range[1]}/${range[2]} ft.` : null;
  if (isRangedWeapon(option)) return span ?? 'Ranged';
  const reach = hasProperty(option, 'reach') ? '10 ft.' : '5 ft.';
  return span && hasProperty(option, 'thrown') ? `${reach} or ${span} thrown` : reach;
}

export interface AttackContext {
  weaponProficiencies: string[];
  /** Weapon names whose mastery property the character can use. */
  masteries: string[];
  /** Monk Martial Arts: Monk weapons may use DEX. */
  martialArts?: boolean;
}

function isMonkWeapon(option: EquipmentOption): boolean {
  if (isRangedWeapon(option)) return false;
  return weaponCategory(option) === 'simple' || hasProperty(option, 'light');
}

/** An Attack for a weapon from the catalog. */
export function weaponAttack(option: EquipmentOption, ctx: AttackContext, name = option.name): Attack {
  const finesse = hasProperty(option, 'finesse') || (ctx.martialArts === true && isMonkWeapon(option));
  const masteryKeys = new Set(ctx.masteries.map((m) => singular(nameKey(m))));
  const mastered = masteryKeys.has(singular(nameKey(option.name)));
  return {
    id: newId(),
    name,
    ability: finesse ? 'finesse' : isRangedWeapon(option) ? 'dex' : 'str',
    proficient: isWeaponProficient(option, ctx.weaponProficiencies),
    damage: option.damage ?? '1',
    damageType: (option.damageType ?? 'bludgeoning').toLowerCase(),
    range: weaponRange(option),
    properties: option.properties,
    mastery: mastered ? option.mastery : undefined,
    notes: versatileNote(option),
  };
}

/**
 * Unarmed Strike (everyone): 1 + STR, or the Martial Arts die with DEX for Monks. The stored die is
 * the level 1 one; `scaling: 'martial-arts'` lets the engine grow it with Monk level (d8 at 5…).
 */
export function unarmedStrike(martialArtsDie: string | null): Attack {
  return {
    id: newId(),
    name: 'Unarmed Strike',
    ability: martialArtsDie ? 'finesse' : 'str',
    proficient: true,
    damage: martialArtsDie ?? '1',
    damageType: 'bludgeoning',
    range: '5 ft.',
    ...(martialArtsDie ? { scaling: 'martial-arts' as const } : {}),
  };
}

export interface StartingGear {
  items: InventoryItem[];
  gp: number;
}

export interface GearContext {
  armorTraining: string[];
}

/**
 * Turn chosen packages into inventory: catalog stats (weight, category), stacking duplicates and
 * equipping armor and a shield the character is trained with. Coins become gp.
 */
export function gearFromPackages(packages: (EquipmentPackage | undefined)[], catalog: EquipmentOption[], ctx: GearContext): StartingGear {
  const items: InventoryItem[] = [];
  let gp = 0;
  let armorEquipped = false;
  let shieldEquipped = false;
  for (const pkg of packages) {
    if (!pkg) continue;
    gp += pkg.gp;
    for (const entry of pkg.items) {
      const match = findEquipment(entry.name, catalog);
      const name = displayName(entry.name, match);
      const existing = items.find((i) => nameKey(i.name) === nameKey(name));
      if (existing) {
        existing.quantity += entry.quantity;
        continue;
      }
      const option = match?.option;
      const item: InventoryItem = {
        id: newId(),
        name,
        quantity: entry.quantity,
        category: itemCategory(option, entry.name),
      };
      if (option?.weight !== undefined) item.weight = option.weight;
      if (option?.description) item.description = option.description;
      if (option) item.compendiumId = option.id;
      if (option && hasArmorTraining(option, ctx.armorTraining)) {
        if (option.category === 'armor' && !armorEquipped) {
          item.equipped = armorEquipped = true;
        } else if (option.category === 'shield' && !shieldEquipped) {
          item.equipped = shieldEquipped = true;
        }
      }
      items.push(item);
    }
  }
  return { items, gp };
}

/** Attacks for every distinct weapon in the inventory (plus an Unarmed Strike). */
export function attacksForInventory(
  items: InventoryItem[],
  catalog: EquipmentOption[],
  ctx: AttackContext & { martialArtsDie?: string | null },
): Attack[] {
  const attacks: Attack[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const option = catalog.find((o) => o.id === item.compendiumId) ?? findEquipment(item.name, catalog)?.option;
    if (!option || option.category !== 'weapon' || !option.damage) continue;
    const key = nameKey(option.name);
    if (seen.has(key)) continue;
    seen.add(key);
    attacks.push(weaponAttack(option, ctx, option.name));
  }
  attacks.push(unarmedStrike(ctx.martialArtsDie ?? null));
  return attacks;
}

/** Weapons the character could pick for Weapon Mastery: proficient ones (melee only if limited). */
export function masteryCandidates(
  catalog: EquipmentOption[],
  proficiencies: string[],
  opts: { meleeOnly?: boolean } = {},
): EquipmentOption[] {
  return catalog.filter(
    (o) =>
      o.category === 'weapon' &&
      Boolean(o.mastery) &&
      isWeaponProficient(o, proficiencies) &&
      !(opts.meleeOnly && isRangedWeapon(o)),
  );
}

/** Short one-line description of a package for option cards: "Chain Mail, Greatsword, 8 Javelins · 4 GP". */
export function describePackage(pkg: EquipmentPackage): string {
  const items = pkg.items.map((i) => (i.quantity > 1 ? `${i.quantity} × ${i.name}` : i.name));
  const parts = [items.join(', ')].filter(Boolean);
  if (pkg.gp) parts.push(`${pkg.gp} GP`);
  return parts.join(' · ') || 'Nothing';
}
