import type { UnitHierarchyRsp, UnitStatsOption } from '../../../../Bindings';
import { readUnitHierarchyTree, type TreeNode } from '../shared/unit-hierarchy';
import type { StatisticsFilterOption } from './StatisticsFilterOptions';
import { UNIT_FILTER_UNSET_ID } from '../../utils/unit-search';

export function statisticsUnitOptions(
  hierarchy: UnitHierarchyRsp | null,
  counts: Pick<UnitStatsOption, 'value' | 'count'>[],
): StatisticsFilterOption[] {
  if (!hierarchy) return [];
  const indexed = new Map(counts.map((option) => [option.value, option]));
  const convert = (node: TreeNode): StatisticsFilterOption => {
    if (node.kind === 'leaf') {
      const value = `unit-id:${node.unitId}`;
      return { value, label: node.label, count: indexed.get(value)?.count };
    }
    const direct = node.children.filter((child) => child.kind === 'leaf');
    if (node.children.length === 1 && direct.length === 1) return convert(direct[0]);
    const own = direct.length === 1 ? direct[0] : null;
    const value = own?.kind === 'leaf' ? `unit-id:${own.unitId}` : `unit-parent:${node.id}`;
    const level = Number(
      node.id
        .replace(/^group:/, '')
        .split('|')
        .at(-1)
        ?.split(':')[0],
    );
    if (level < 2)
      return {
        value: `unit-branch:${node.id}`,
        label: node.label,
        selectable: false,
        children: node.children.map(convert),
      };
    return {
      value,
      label: own?.label ?? node.label,
      count: indexed.get(value)?.count,
      selectable: level >= 2,
      children: node.children.filter((child) => child !== own).map(convert),
    };
  };
  const options = readUnitHierarchyTree(hierarchy).map(convert);
  const undefinedValue = `unit-id:${UNIT_FILTER_UNSET_ID}`;
  return [
    ...options,
    { value: undefinedValue, label: 'Не визначено', count: indexed.get(undefinedValue)?.count },
  ];
}
