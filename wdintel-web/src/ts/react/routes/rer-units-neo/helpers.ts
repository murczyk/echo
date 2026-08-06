import type { CreateUnitReq, Unit } from '../../../../Bindings';

export type UnitForm = CreateUnitReq;
export type UnitStatusFilter = 'all' | 'active' | 'inactive';

export const EMPTY_UNIT_FORM: UnitForm = {
  company: '',
  battalion: '',
  regiment: '',
  division: '',
  army: '',
  militaryDistrict: '',
  armyRegion: '',
  active: true,
  isDeduplicateCandidate: null,
  comment: '',
  orbitNote: null,
};

export function unitToForm(unit: Unit): UnitForm {
  return {
    company: unit.company,
    battalion: unit.battalion,
    regiment: unit.regiment,
    division: unit.division,
    army: unit.army,
    militaryDistrict: unit.militaryDistrict,
    armyRegion: unit.armyRegion,
    active: unit.active,
    isDeduplicateCandidate: unit.isDeduplicateCandidate,
    comment: unit.comment,
    orbitNote: unit.orbitNote,
  };
}

export function trimUnitForm(form: UnitForm): UnitForm {
  return {
    company: form.company.trim(),
    battalion: form.battalion.trim(),
    regiment: form.regiment.trim(),
    division: form.division.trim(),
    army: form.army.trim(),
    militaryDistrict: form.militaryDistrict.trim(),
    armyRegion: form.armyRegion.trim(),
    active: form.active,
    isDeduplicateCandidate: form.isDeduplicateCandidate,
    comment: form.comment.trim(),
    orbitNote: form.orbitNote?.trim() || null,
  };
}

export function unitNameParts(form: UnitForm): string[] {
  return [
    form.company,
    form.battalion,
    form.regiment,
    form.division,
    form.army,
    form.militaryDistrict,
    form.armyRegion,
  ]
    .map((value) => value.trim())
    .filter(Boolean);
}

export function unitName(form: UnitForm): string {
  return unitNameParts(form).join(' ');
}

export function isUnitFormValid(form: UnitForm): boolean {
  return unitNameParts(form).length > 0;
}

export function uniqueTrimmed(values: string[]): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => {
        const key = item.toLocaleLowerCase();
        if (!item || seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
  );
}

export function defaultUnitMasks(form: UnitForm): string[] {
  const parts = unitNameParts(form);
  return uniqueTrimmed([parts.join(' '), [...parts].reverse().join(' ')]);
}

export function findPotentialDuplicates(units: Unit[], form: UnitForm): Unit[] {
  const fields = [
    'company',
    'battalion',
    'regiment',
    'division',
    'army',
    'militaryDistrict',
    'armyRegion',
  ] as const;
  const inputs = fields.map((field) => form[field].trim().toLocaleLowerCase());
  if (inputs.every((value) => value === '')) return [];

  return units.filter((unit) =>
    fields.every((field, index) => {
      const input = inputs[index];
      const value = unit[field].trim().toLocaleLowerCase();
      return input === '' || (value !== '' && value.includes(input));
    }),
  );
}

export function unitStatusCounts(units: Unit[]): { active: number; inactive: number } {
  return units.reduce(
    (counts, unit) => ({
      active: counts.active + Number(unit.active),
      inactive: counts.inactive + Number(!unit.active),
    }),
    { active: 0, inactive: 0 },
  );
}

export function filterUnitsByStatus(units: Unit[], status: UnitStatusFilter): Unit[] {
  if (status === 'all') return units;
  const active = status === 'active';
  return units.filter((unit) => unit.active === active);
}

export function formatUnitError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Сталася невідома помилка';
}
