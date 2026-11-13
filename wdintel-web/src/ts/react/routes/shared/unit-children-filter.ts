import type { Unit } from '../../../../Bindings';
import { getUnitIdFilterValue } from '../../utils/unit-search';
import { buildUnitHierarchyTree, HIERARCHY_KEYS, type TreeNode } from './unit-hierarchy';

export type UnitCountOption = {
  value: string;
  label: string;
  count: number;
  values?: string[];
};

export type UnitHierarchyIndex = {
  children: Map<string, string[]>;
  exact: Map<string, string[]>;
  parents: Array<{ value: string; label: string; descendants: string[] }>;
};

const UNIT_PARENT_PREFIX = 'unit-parent:';

export function isUnitParentValue(value: string): boolean {
  return value.startsWith(UNIT_PARENT_PREFIX);
}

export function buildUnitHierarchyIndex(units: Unit[]): UnitHierarchyIndex {
  return indexUnitHierarchyTree(
    buildUnitHierarchyTree(
      units.map((unit) => ({ ...unit, unitId: unit.id, unitName: unit.name, count: 0 })),
    ),
    units,
  );
}

export function indexUnitHierarchyTree(
  tree: TreeNode[],
  units: Array<Pick<Unit, 'id' | 'name'>>,
): UnitHierarchyIndex {
  const index: UnitHierarchyIndex = { children: new Map(), exact: new Map(), parents: [] };
  const visit = (node: TreeNode): string[] => {
    if (node.kind === 'leaf') return [getUnitIdFilterValue(node.unitId)];
    const descendants = node.children.flatMap(visit);
    const directUnits = node.children.flatMap((child) =>
      child.kind === 'leaf' ? [getUnitIdFilterValue(child.unitId)] : [],
    );
    directUnits.forEach((value) => index.children.set(value, descendants));
    const level = node.id
      .replace(/^group:/, '')
      .split('|')
      .at(-1)
      ?.split(':')[0];
    if (Number(level) < 2) return descendants;
    const value = directUnits.length === 1 ? directUnits[0] : `${UNIT_PARENT_PREFIX}${node.id}`;
    index.children.set(value, descendants);
    index.exact.set(value, directUnits);
    if (node.children.some((child) => child.kind === 'group') || directUnits.length > 1) {
      const label = HIERARCHY_KEYS.slice(2)
        .map((key) => node.hierarchy[key]?.trim())
        .filter(Boolean)
        .reverse()
        .join(' ');
      index.parents.push({ value, label, descendants });
    }
    return descendants;
  };
  tree.forEach(visit);
  units.forEach((unit) => {
    const value = getUnitIdFilterValue(unit.id);
    const name = unit.name.trim();
    if (!name) return;
    index.children.set(name, [
      ...new Set([...(index.children.get(name) ?? []), ...(index.children.get(value) ?? [value])]),
    ]);
  });
  return index;
}

export function expandUnitSelections(
  values: readonly string[],
  includeChildren: boolean,
  hierarchy?: UnitHierarchyIndex | null,
): string[] {
  return [
    ...new Set(
      values.flatMap((value) => {
        if (includeChildren) return hierarchy?.children.get(value) ?? [value];
        if (isUnitParentValue(value)) {
          return hierarchy?.exact.get(value) ?? [];
        }
        return [value];
      }),
    ),
  ];
}

export function aggregateUnitParentOptions(
  options: readonly UnitCountOption[],
  hierarchy: UnitHierarchyIndex,
): UnitCountOption[] {
  const counts = new Map<string, number>();
  options.forEach((option) => {
    (option.values ?? [option.value]).forEach((value) => counts.set(value, option.count));
  });
  const merged = new Map(options.map((option) => [option.value, option]));
  hierarchy.parents.forEach(({ value, label, descendants }) => {
    const count = descendants.reduce((total, child) => total + (counts.get(child) ?? 0), 0);
    if (count > 0) merged.set(value, { value, label: merged.get(value)?.label ?? label, count });
  });
  return [...merged.values()].sort((a, b) => a.label.localeCompare(b.label));
}
