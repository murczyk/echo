import { AreaOfResponsibility, Login, Organism } from '../../../../Bindings';

export type AorColumnLookup = {
  labelsByOrganismId: Map<number, string[]>;
  filterOptions: { text: string; value: string }[];
};

/** Labels stay empty until the AOR list has loaded or failed, then fall back to IDs. */
export function buildAorColumnLookup(
  organisms: Organism[],
  aors: AreaOfResponsibility[],
  labelsReady: boolean,
): AorColumnLookup {
  const aorById = new Map(aors.map((aor) => [aor.id, aor]));
  const labelsByOrganismId = new Map(
    organisms.map((organism) => [
      organism.id,
      labelsReady ? organism.aorIds.map((id) => aorById.get(id)?.name || String(id)) : [],
    ]),
  );
  const filterOptions = Array.from(new Set(aors.map((aor) => aor.name).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'uk-UA'))
    .map((name) => ({ text: name, value: name }));
  return { labelsByOrganismId, filterOptions };
}

export function organismAorLabels(login: Login, aorLookup: AorColumnLookup): string[] {
  if (login.organismId === null) return [];
  return aorLookup.labelsByOrganismId.get(login.organismId) ?? [];
}
