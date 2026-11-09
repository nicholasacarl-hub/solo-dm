import { Backpack, Coins, Shield } from 'lucide-react';
import { nameKey } from '@/lib/id';
import { Badge, Card } from '@/ui/components/ui';
import { Issues, RadioCards, StepHeader, SubHeading, ToggleChip } from '../BuilderParts';
import { describePackage, findEquipment, gearFromPackages, masteryPlan, picks, toggleInList, validateStep } from '../logic';
import type { StepProps } from './stepTypes';

export function EquipmentStep({ draft, setDraft, ctx, onDmDecide, built }: StepProps) {
  const { data } = ctx;
  const { cls, background } = picks(draft, data);
  const mastery = masteryPlan(draft, data);
  const packages = [
    draft.classEquipment === null ? undefined : cls?.startingEquipment[draft.classEquipment],
    draft.backgroundEquipment === null ? undefined : background?.equipment[draft.backgroundEquipment],
  ];
  const sources = [cls?.source?.sourceId, background?.source?.sourceId];
  const packed = new Set(
    packages
      .flatMap((p, i) => (p?.items ?? []).map((item) => findEquipment(item.name, data.equipment, sources[i])?.option.name))
      .filter((n): n is string => Boolean(n))
      .map(nameKey),
  );
  // Items a book's package names that the gear list doesn't know: they're added as plain gear.
  const fromBooks = packages.map((p, i) => (sources[i] ? p : undefined));
  const unmatched = gearFromPackages(fromBooks, data.equipment, { armorTraining: [], sources }).unmatched;
  const masteryFull = draft.weaponMasteries.length >= mastery.count;
  const issues = validateStep('equipment', draft, ctx).filter((e) => !e.startsWith('Choose your'));
  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        title="Starting equipment"
        description="Take the gear packages from your class and background, or take the gold instead and shop with the DM later. Armor and a shield you're trained with are equipped for you."
        onDmDecide={onDmDecide}
      />
      {cls && cls.startingEquipment.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>{cls.name} equipment</SubHeading>
          <RadioCards<string>
            label={`${cls.name} starting equipment`}
            value={draft.classEquipment === null ? null : String(draft.classEquipment)}
            onChange={(v) => setDraft((d) => ({ ...d, classEquipment: Number(v) }))}
            options={cls.startingEquipment.map((p, i) => ({
              value: String(i),
              title: p.items.length ? p.label : `${p.label}: gold`,
              meta: p.gp ? <Badge tone="gold">{p.gp} GP</Badge> : undefined,
              description: p.items.length ? describePackage({ ...p, gp: 0 }) : 'Buy your own gear later.',
            }))}
          />
        </div>
      )}
      {background && background.equipment.length > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading>{background.name} equipment</SubHeading>
          <RadioCards<string>
            label={`${background.name} equipment`}
            value={draft.backgroundEquipment === null ? null : String(draft.backgroundEquipment)}
            onChange={(v) => setDraft((d) => ({ ...d, backgroundEquipment: Number(v) }))}
            options={background.equipment.map((p, i) => ({
              value: String(i),
              title: p.items.length ? p.label : `${p.label}: gold`,
              meta: p.gp ? <Badge tone="gold">{p.gp} GP</Badge> : undefined,
              description: p.items.length ? describePackage({ ...p, gp: 0 }) : 'Buy your own gear later.',
            }))}
          />
        </div>
      )}
      {mastery.count > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading hint={`${draft.weaponMasteries.length}/${mastery.count}`}>Weapon Mastery</SubHeading>
          <p className="text-sm text-muted">Choose {mastery.count} kinds of weapons whose mastery property you can use. Weapons in your pack are marked.</p>
          <div className="flex flex-wrap gap-1.5">
            {[...mastery.candidates].sort((a, b) => Number(packed.has(nameKey(b.name))) - Number(packed.has(nameKey(a.name)))).map((w) => {
              const chosen = draft.weaponMasteries.includes(w.name);
              return (
                <ToggleChip
                  key={w.id}
                  pressed={chosen}
                  disabled={!chosen && masteryFull}
                  reason={!chosen && masteryFull ? 'Unselect one first' : undefined}
                  onToggle={() => setDraft((d) => ({ ...d, weaponMasteries: toggleInList(d.weaponMasteries, w.name, mastery.count) }))}
                >
                  {w.name}
                  <span className="text-xs text-faint">{w.mastery}</span>
                  {packed.has(nameKey(w.name)) && <Backpack className="size-3.5 text-accent" role="img" aria-label="in your pack" />}
                </ToggleChip>
              );
            })}
          </div>
        </div>
      )}
      <Issues issues={issues} />
      {unmatched.length > 0 && (
        <p className="text-sm text-muted">
          {unmatched.map((n) => `${n} isn't in your gear list`).join('; ')}: {unmatched.length === 1 ? "it's" : "they're"} added as plain gear (ask your DM what {unmatched.length === 1 ? 'it does' : 'they do'}).
        </p>
      )}
      {built && (
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="inline-flex items-center gap-1.5">
              <Shield className="size-4 text-accent" aria-hidden />
              <span className="font-semibold tabular-nums">AC {built.armorClass}</span>
              {built.acFormula && <span className="text-muted">({built.acFormula})</span>}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Coins className="size-4 text-gold" aria-hidden />
              <span className="font-semibold tabular-nums text-gold">{built.currency.gp} GP</span>
            </span>
          </div>
          {built.inventory.length > 0 ? (
            <ul className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
              {built.inventory.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-2 border-b border-border/60 py-1">
                  <span className="truncate">
                    {i.name}
                    {i.equipped && <span className="ml-1.5 text-xs text-accent">equipped</span>}
                  </span>
                  <span className="text-muted tabular-nums">×{i.quantity}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No gear yet — just coin.</p>
          )}
        </Card>
      )}
    </div>
  );
}
