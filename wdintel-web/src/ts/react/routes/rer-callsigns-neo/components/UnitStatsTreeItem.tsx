import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Collapse, List, ListItemButton, ListItemText } from '@mui/material';
import { memo } from 'react';
import { PowerIconButton } from '../../../components/PowerIconButton';
import type { SelectedSidebarUnitFilter } from '../types';
import {
  areHierarchyFiltersEqual,
  isSelectedLeafNode,
  type UnitStatsTreeNode,
} from './UnitStatsSidebar.tree';
import { getUnitStatsItemsLabel, UnitStatsCounter } from './UnitStatsCounters';

type Props = {
  node: UnitStatsTreeNode;
  depth: number;
  expandedIds: Set<string>;
  onToggle: (nodeId: string) => void;
  onPickUnitFilter: (filter: SelectedSidebarUnitFilter) => void;
  selectedUnitFilter?: SelectedSidebarUnitFilter;
  countLabel: string;
};

export const UnitTreeItem = memo(function UnitTreeItemComponent({
  node,
  depth,
  expandedIds,
  onToggle,
  onPickUnitFilter,
  selectedUnitFilter,
  countLabel,
}: Props) {
  const paddingLeft = 1 + depth * 2;
  const ownUnit = node.kind === 'leaf' ? node : node.ownUnit;
  const ownCount = ownUnit?.count ?? 0;
  const ownFilter: SelectedSidebarUnitFilter | undefined = ownUnit
    ? { kind: 'leaf', label: node.label, unitName: ownUnit.unitName, unitId: ownUnit.unitId }
    : undefined;
  const subtreeFilter: SelectedSidebarUnitFilter = node.hierarchy
    ? { kind: 'group', label: node.label, hierarchy: node.hierarchy }
    : ownFilter!;
  const isSelected =
    subtreeFilter.kind === 'group'
      ? selectedUnitFilter?.kind === 'group' &&
        areHierarchyFiltersEqual(subtreeFilter.hierarchy, selectedUnitFilter.hierarchy)
      : Boolean(ownUnit && isSelectedLeafNode(ownUnit, selectedUnitFilter));
  const isExpanded = node.kind === 'group' && expandedIds.has(node.id);
  const collapseId = `${node.id}-children`;
  const countedItems = getUnitStatsItemsLabel(countLabel);
  const ownTitle = `Власні ${countedItems} підрозділу ${node.label}: ${ownCount}; натисніть для перегляду`;

  return (
    <>
      <div className="flex items-center pr-echo-md">
        {node.kind === 'group' ? (
          <PowerIconButton
            size="small"
            onClick={() => onToggle(node.id)}
            aria-expanded={isExpanded}
            aria-controls={collapseId}
            aria-label={`${isExpanded ? 'Згорнути' : 'Розгорнути'} гілку ${node.label}`}
            sx={{ ml: paddingLeft, mr: 0.5 }}
          >
            {isExpanded ? (
              <ExpandMoreIcon fontSize="small" />
            ) : (
              <ChevronRightIcon fontSize="small" />
            )}
          </PowerIconButton>
        ) : null}
        <ListItemButton
          onClick={() => onPickUnitFilter(subtreeFilter)}
          selected={isSelected}
          className="min-w-0! flex-1! pr-0!"
          sx={node.kind === 'leaf' ? { pl: paddingLeft + 5 } : undefined}
          aria-label={`Фільтрувати за ${node.kind === 'group' ? 'гілкою' : 'підрозділом'} ${node.label}, ${countLabel.toLocaleLowerCase()} ${node.count}`}
        >
          <ListItemText
            primary={node.label}
            primaryTypographyProps={{ noWrap: true, title: node.label }}
          />
          {node.count !== ownCount || ownCount === 0 ? (
            <span className="ml-echo-sm shrink-0">
              <UnitStatsCounter count={node.count} title={`Всі ${countedItems}: ${node.count}`} />
            </span>
          ) : null}
        </ListItemButton>
        {ownCount > 0 && ownFilter ? (
          <span className="ml-echo-sm shrink-0">
            <UnitStatsCounter
              count={ownCount}
              own
              selected={ownUnit && isSelectedLeafNode(ownUnit, selectedUnitFilter)}
              onClick={() => onPickUnitFilter(ownFilter)}
              title={ownTitle}
            />
          </span>
        ) : null}
      </div>
      {node.kind === 'group' ? (
        <Collapse in={isExpanded} timeout="auto" unmountOnExit id={collapseId}>
          <List dense disablePadding>
            {node.children.map((child) => (
              <UnitTreeItem
                key={child.id}
                node={child}
                depth={depth + 1}
                expandedIds={expandedIds}
                onToggle={onToggle}
                onPickUnitFilter={onPickUnitFilter}
                selectedUnitFilter={selectedUnitFilter}
                countLabel={countLabel}
              />
            ))}
          </List>
        </Collapse>
      ) : null}
    </>
  );
});
