import {
  buildUnitHierarchyTree,
  HIERARCHY_KEYS,
  type TreeLeafNode,
  type TreeNode,
} from '../../shared/unit-hierarchy';
import type { SelectedSidebarUnitFilter, UnitHierarchyFilter, UnitStatView } from '../types';

export type UnitStatsTreeNode =
  | (TreeLeafNode & { hierarchy?: UnitHierarchyFilter })
  | (Omit<Extract<TreeNode, { kind: 'group' }>, 'children'> & {
      ownUnit?: TreeLeafNode;
      children: UnitStatsTreeNode[];
    });

function mergeOwnUnitCounts(nodes: TreeNode[]): UnitStatsTreeNode[] {
  return nodes.map((node) => {
    if (node.kind === 'leaf') return node;
    if (node.children.length === 1 && node.children[0].kind === 'leaf') {
      return { ...node.children[0], label: node.label, hierarchy: node.hierarchy };
    }

    const directUnits = node.children.filter((child) => child.kind === 'leaf');
    const ownUnit = directUnits.length === 1 ? directUnits[0] : undefined;
    return {
      ...node,
      ownUnit,
      children: mergeOwnUnitCounts(node.children.filter((child) => child !== ownUnit)),
    };
  });
}

export function buildUnitTree(
  stats: UnitStatView[],
  cachedTree?: TreeNode[] | null,
): UnitStatsTreeNode[] {
  if (!cachedTree) return mergeOwnUnitCounts(buildUnitHierarchyTree(stats));
  const rows = new Map(stats.map((row, rank) => [row.unitId, { row, rank }]));
  const ranks = new Map<string, number>();
  const visit = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .flatMap((node): TreeNode[] => {
        if (node.kind === 'leaf') {
          const match = rows.get(node.unitId);
          if (!match) return [];
          rows.delete(node.unitId);
          ranks.set(node.id, match.rank);
          return [
            {
              ...node,
              unitName: match.row.unitName,
              label: match.row.unitName,
              count: match.row.count,
            },
          ];
        }
        const children = visit(node.children);
        if (children.length === 0) return [];
        ranks.set(
          node.id,
          children.reduce((rank, child) => Math.min(rank, ranks.get(child.id)!), Infinity),
        );
        return [
          { ...node, children, count: children.reduce((total, child) => total + child.count, 0) },
        ];
      })
      .sort((left, right) => ranks.get(left.id)! - ranks.get(right.id)!);
  const nodes = visit(cachedTree);
  rows.forEach(({ row, rank }) => {
    const id = `unit:${row.unitId}`;
    ranks.set(id, rank);
    nodes.push({
      kind: 'leaf',
      id,
      unitId: row.unitId,
      unitName: row.unitName,
      label: row.unitName,
      count: row.count,
    });
  });
  nodes.sort((left, right) => ranks.get(left.id)! - ranks.get(right.id)!);
  return mergeOwnUnitCounts(nodes);
}

export function reconcileUnitStats(
  stats: UnitStatView[],
  cachedTree?: TreeNode[] | null,
): UnitStatView[] {
  if (!cachedTree) return stats;
  const current = new Map<number, Partial<UnitStatView>>();
  const visit = (nodes: TreeNode[], hierarchy: Partial<UnitStatView>) => {
    nodes.forEach((node) => {
      if (node.kind === 'leaf') {
        current.set(node.unitId, { ...hierarchy, unitName: node.unitName });
      } else {
        visit(
          node.children,
          Object.fromEntries(HIERARCHY_KEYS.map((key) => [key, node.hierarchy[key] ?? ''])),
        );
      }
    });
  };
  visit(cachedTree, Object.fromEntries(HIERARCHY_KEYS.map((key) => [key, ''])));
  return stats.map((row) => ({ ...row, ...current.get(row.unitId) }));
}

export function collectGroupIds(nodes: UnitStatsTreeNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.kind !== 'group') continue;
    ids.push(node.id, ...collectGroupIds(node.children));
  }
  return ids;
}

export function normalizeSearchQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function areHierarchyFiltersEqual(
  left: UnitHierarchyFilter,
  right: UnitHierarchyFilter,
): boolean {
  return HIERARCHY_KEYS.every((key) => left[key] === right[key]);
}

export function matchesUnitSearch(row: UnitStatView, normalizedQuery: string): boolean {
  if (normalizedQuery === '') return true;

  const haystack = [
    row.unitName,
    row.armyRegion,
    row.militaryDistrict,
    row.army,
    row.corps,
    row.division,
    row.brigade,
    row.regiment,
    row.battalion,
    row.company,
    row.platoon,
    row.squad,
    row.section,
    row.teamOrCrew,
    row.other,
  ]
    .join(' ')
    .toLocaleLowerCase();

  return haystack.includes(normalizedQuery);
}

export function collectExpansionPathToSelectedFilter(
  nodes: UnitStatsTreeNode[],
  selectedUnitFilter: SelectedSidebarUnitFilter,
): string[] {
  const path = collectExpansionPathToSelectedFilterInner(nodes, selectedUnitFilter);
  return path ?? [];
}

export function isSelectedLeafNode(
  node: TreeLeafNode,
  selectedUnitFilter?: SelectedSidebarUnitFilter,
) {
  if (selectedUnitFilter?.kind !== 'leaf') return false;
  if (selectedUnitFilter.unitId !== undefined) return selectedUnitFilter.unitId === node.unitId;
  return selectedUnitFilter.unitName === node.unitName;
}

function collectExpansionPathToSelectedFilterInner(
  nodes: UnitStatsTreeNode[],
  selectedUnitFilter: SelectedSidebarUnitFilter,
): string[] | null {
  for (const node of nodes) {
    if (
      selectedUnitFilter.kind === 'group' &&
      node.hierarchy &&
      areHierarchyFiltersEqual(node.hierarchy, selectedUnitFilter.hierarchy)
    ) {
      return node.kind === 'group' ? [node.id] : [];
    }

    if (node.kind === 'leaf') {
      if (isSelectedLeafNode(node, selectedUnitFilter)) return [];
      continue;
    }
    if (node.ownUnit && isSelectedLeafNode(node.ownUnit, selectedUnitFilter)) return [];

    const childPath = collectExpansionPathToSelectedFilterInner(node.children, selectedUnitFilter);
    if (childPath !== null) {
      return [node.id, ...childPath];
    }
  }

  return null;
}
