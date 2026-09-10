import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ClearIcon from '@mui/icons-material/Clear';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import SearchIcon from '@mui/icons-material/Search';
import {
  Box,
  CircularProgress,
  Collapse,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { isPresent } from '../../../utils/misc';

import { PowerChip } from '../../../components/PowerChip';
import { SectionLoadingOverlay } from '../../../components/SectionLoadingOverlay';
import type { SelectedSidebarUnitFilter, UnitHierarchyFilter, UnitStatView } from '../types';

type Props = {
  stats: UnitStatView[];
  open: boolean;
  isDesktopLayout: boolean;
  loading: boolean;
  onPickUnitFilter: (filter: SelectedSidebarUnitFilter) => void;
  onToggleInvestigating?: (next: boolean) => void;
  onToggleOpen?: () => void;
  showInvestigatingFilter?: boolean;
  isInvestigating?: boolean;
  selectedUnitFilter?: SelectedSidebarUnitFilter;
  countLabel?: string;
};

type TreeLeafNode = {
  kind: 'leaf';
  id: string;
  unitId: number;
  label: string;
  unitName: string;
  count: number;
};

type TreeGroupNode = {
  kind: 'group';
  id: string;
  label: string;
  count: number;
  hierarchy: UnitHierarchyFilter;
  children: TreeNode[];
};

type TreeNode = TreeGroupNode | TreeLeafNode;

const HIERARCHY_LABELS = [
  'Армійський регіон',
  'Військовий округ',
  'Армія',
  'Корпус',
  'Дивізія',
  'Бригада',
  'Полк',
  'Батальйон',
  'Рота',
  'Взвод',
  'Відділення',
  'Секція',
  'Команда/Екіпаж',
  'Інше',
] as const;
const HIERARCHY_KEYS = [
  'armyRegion',
  'militaryDistrict',
  'army',
  'corps',
  'division',
  'brigade',
  'regiment',
  'battalion',
  'company',
  'platoon',
  'squad',
  'section',
  'teamOrCrew',
  'other',
] as const;
const SIDEBAR_FILTER_DEBOUNCE_MS = 180;

function collapseTerminalSingleUnitGroups(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.kind === 'leaf') return node;
    if (node.children.length === 1 && node.children[0].kind === 'leaf') {
      return { ...node.children[0], label: node.label };
    }

    return { ...node, children: collapseTerminalSingleUnitGroups(node.children) };
  });
}

export function buildUnitTree(stats: UnitStatView[]): TreeNode[] {
  const root: TreeNode[] = [];
  const groups = new Map<string, TreeGroupNode>();

  for (const row of stats) {
    const rawParts = [
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
    ];
    const firstVisibleLevel =
      row.armyRegion.trim() !== '' ? 0 : row.militaryDistrict.trim() !== '' ? 1 : 2;
    let parentChildren = root;
    let path: string[] = [];
    let rawPath: string[] = [];

    rawParts.forEach((part, level) => {
      if (level < firstVisibleLevel) return;
      const hasAnyDeeperPart = rawParts.slice(level).some((item) => item.trim() !== '');
      if (!hasAnyDeeperPart) return;

      const rawValue = part.trim();
      path = [...path, `${level}:${rawValue === '' ? '__EMPTY__' : rawValue}`];
      rawPath = [...rawPath];
      rawPath[level] = rawValue;
      if (rawValue === '') return;

      const id = `group:${path.join('|')}`;

      let group = groups.get(id);
      if (!group) {
        group = {
          kind: 'group',
          id,
          label: rawValue,
          count: 0,
          hierarchy: createHierarchyFilter(rawPath),
          children: [],
        };
        groups.set(id, group);
        parentChildren.push(group);
      }

      group.count += row.count;
      parentChildren = group.children;
    });

    parentChildren.push({
      kind: 'leaf',
      id: `unit:${row.unitId}`,
      unitId: row.unitId,
      label: row.unitName,
      unitName: row.unitName,
      count: row.count,
    });
  }

  return collapseTerminalSingleUnitGroups(root);
}

function collectGroupIds(nodes: TreeNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.kind !== 'group') continue;
    ids.push(node.id, ...collectGroupIds(node.children));
  }
  return ids;
}

function normalizeSearchQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function createHierarchyFilter(rawPath: string[]): UnitHierarchyFilter {
  return {
    armyRegion: rawPath[0] ?? null,
    militaryDistrict: rawPath[1] ?? null,
    army: rawPath[2] ?? null,
    corps: rawPath[3] ?? null,
    division: rawPath[4] ?? null,
    brigade: rawPath[5] ?? null,
    regiment: rawPath[6] ?? null,
    battalion: rawPath[7] ?? null,
    company: rawPath[8] ?? null,
    platoon: rawPath[9] ?? null,
    squad: rawPath[10] ?? null,
    section: rawPath[11] ?? null,
    teamOrCrew: rawPath[12] ?? null,
    other: rawPath[13] ?? null,
  };
}

function areHierarchyFiltersEqual(left: UnitHierarchyFilter, right: UnitHierarchyFilter): boolean {
  return HIERARCHY_KEYS.every((key) => left[key] === right[key]);
}

function matchesUnitSearch(row: UnitStatView, normalizedQuery: string): boolean {
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

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [value, delayMs]);

  return debouncedValue;
}

function collectExpansionPathToSelectedFilter(
  nodes: TreeNode[],
  selectedUnitFilter: SelectedSidebarUnitFilter,
): string[] {
  const path = collectExpansionPathToSelectedFilterInner(nodes, selectedUnitFilter);
  return path ?? [];
}

function isSelectedLeafNode(node: TreeLeafNode, selectedUnitFilter?: SelectedSidebarUnitFilter) {
  if (selectedUnitFilter?.kind !== 'leaf') return false;
  if (selectedUnitFilter.unitId !== undefined) return selectedUnitFilter.unitId === node.unitId;
  return selectedUnitFilter.unitName === node.unitName;
}

function collectExpansionPathToSelectedFilterInner(
  nodes: TreeNode[],
  selectedUnitFilter: SelectedSidebarUnitFilter,
): string[] | null {
  for (const node of nodes) {
    if (node.kind === 'leaf') {
      if (isSelectedLeafNode(node, selectedUnitFilter)) return [];
      continue;
    }

    if (
      selectedUnitFilter.kind === 'group' &&
      areHierarchyFiltersEqual(node.hierarchy, selectedUnitFilter.hierarchy)
    ) {
      return [node.id];
    }

    const childPath = collectExpansionPathToSelectedFilterInner(node.children, selectedUnitFilter);
    if (childPath !== null) {
      return [node.id, ...childPath];
    }
  }

  return null;
}

type TreeItemProps = {
  node: TreeNode;
  depth: number;
  expandedIds: Set<string>;
  onToggle: (nodeId: string) => void;
  onPickUnitFilter: (filter: SelectedSidebarUnitFilter) => void;
  selectedUnitFilter?: SelectedSidebarUnitFilter;
  countLabel: string;
};

function UnitTreeItem({
  node,
  depth,
  expandedIds,
  onToggle,
  onPickUnitFilter,
  selectedUnitFilter,
  countLabel,
}: TreeItemProps) {
  const paddingLeft = 1 + depth * 2;

  if (node.kind === 'leaf') {
    return (
      <ListItemButton
        onClick={() =>
          onPickUnitFilter({
            kind: 'leaf',
            label: node.label,
            unitName: node.unitName,
            unitId: node.unitId,
          })
        }
        selected={isSelectedLeafNode(node, selectedUnitFilter)}
        sx={{ pl: paddingLeft + 5, pr: 1.5 }}
        aria-label={`Фільтрувати за підрозділом ${node.label}, ${countLabel.toLocaleLowerCase()} ${node.count}`}
      >
        <ListItemText
          primary={node.label}
          primaryTypographyProps={{ noWrap: true, title: node.label }}
        />
        <PowerChip
          size="small"
          label={node.count}
          interactive={false}
          unselectedOpacity={1}
          unselectedBackgroundColor="action.selected"
          unselectedTextColor="text.primary"
          unselectedBorderColor="transparent"
          sx={{ ml: 1 }}
        />
      </ListItemButton>
    );
  }

  const isExpanded = expandedIds.has(node.id);
  const isSelected =
    selectedUnitFilter?.kind === 'group' &&
    areHierarchyFiltersEqual(node.hierarchy, selectedUnitFilter.hierarchy);
  const collapseId = `${node.id}-children`;

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'stretch' }}>
        <IconButton
          size="small"
          onClick={() => onToggle(node.id)}
          aria-expanded={isExpanded}
          aria-controls={collapseId}
          aria-label={`${isExpanded ? 'Згорнути' : 'Розгорнути'} гілку ${node.label}`}
          sx={{
            ml: paddingLeft,
            mr: 0.5,
            alignSelf: 'center',
          }}
        >
          {isExpanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
        </IconButton>
        <ListItemButton
          onClick={() =>
            onPickUnitFilter({ kind: 'group', label: node.label, hierarchy: node.hierarchy })
          }
          selected={isSelected}
          sx={{ minWidth: 0, flex: 1, pr: 1.5 }}
          aria-label={`Фільтрувати за гілкою ${node.label}, ${countLabel.toLocaleLowerCase()} ${node.count}`}
        >
          <ListItemText
            primary={node.label}
            primaryTypographyProps={{ noWrap: true, title: node.label }}
          />
          <PowerChip
            size="small"
            label={node.count}
            interactive={false}
            unselectedOpacity={1}
            unselectedBackgroundColor="action.selected"
            unselectedTextColor="text.primary"
            unselectedBorderColor="transparent"
            sx={{ ml: 1 }}
          />
        </ListItemButton>
      </Box>
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
    </>
  );
}

function formatSelectedFilterLabel(selectedUnitFilter: SelectedSidebarUnitFilter): string {
  if (selectedUnitFilter.kind === 'leaf') {
    return `Підрозділ: ${selectedUnitFilter.label}`;
  }

  const deepestLevelIndex = HIERARCHY_KEYS.reduce<number>((lastIndex, key, index) => {
    const value = selectedUnitFilter.hierarchy[key];
    return isPresent(value) && value.trim() !== '' ? index : lastIndex;
  }, -1);
  const hierarchyLabel = deepestLevelIndex >= 0 ? HIERARCHY_LABELS[deepestLevelIndex] : 'Підрозділ';

  return `${hierarchyLabel}: ${selectedUnitFilter.label}`;
}

export function UnitStatsSidebar({
  stats,
  open,
  isDesktopLayout,
  loading,
  onPickUnitFilter,
  onToggleInvestigating,
  onToggleOpen,
  showInvestigatingFilter = false,
  isInvestigating = false,
  selectedUnitFilter,
  countLabel = 'Позивних',
}: Props) {
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearchInput = useDebouncedValue(searchInput, SIDEBAR_FILTER_DEBOUNCE_MS);
  const normalizedSearchQuery = useMemo(
    () => normalizeSearchQuery(debouncedSearchInput),
    [debouncedSearchInput],
  );
  const filteredStats = useMemo(
    () => stats.filter((row) => matchesUnitSearch(row, normalizedSearchQuery)),
    [stats, normalizedSearchQuery],
  );
  const tree = useMemo(() => buildUnitTree(filteredStats), [filteredStats]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const total = filteredStats.reduce((sum, row) => sum + row.count, 0);
  const totalOverall = stats.reduce((sum, row) => sum + row.count, 0);

  useEffect(() => {
    if (!open) return;
    if (normalizedSearchQuery !== '') {
      setExpandedIds(new Set(collectGroupIds(tree)));
      return;
    }

    if (!selectedUnitFilter) {
      return;
    }

    const path = collectExpansionPathToSelectedFilter(tree, selectedUnitFilter);
    setExpandedIds(new Set(path));
  }, [open, tree, selectedUnitFilter, normalizedSearchQuery]);

  if (!open) {
    return (
      <Paper
        variant="outlined"
        sx={{
          display: isDesktopLayout ? 'none' : 'flex',
          width: '100%',
          alignItems: 'center',
          justifyContent: 'space-between',
          p: 2,
          borderRadius: 0,
        }}
      >
        <Typography variant="h6">Підрозділи</Typography>
        {onToggleOpen ? (
          <IconButton
            onClick={onToggleOpen}
            aria-label="Показати панель підрозділів"
            title="Показати панель підрозділів"
            sx={{ color: 'text.primary' }}
          >
            <KeyboardArrowDownIcon />
          </IconButton>
        ) : null}
      </Paper>
    );
  }

  function onToggle(nodeId: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }

  return (
    <Paper
      variant="outlined"
      sx={{
        width: isDesktopLayout ? 320 : '100%',
        minWidth: isDesktopLayout ? 280 : 0,
        height: isDesktopLayout ? '100%' : 'auto',
        maxHeight: isDesktopLayout ? '100%' : '36vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 0,
        borderRight: '1px solid',
        borderColor: 'divider',
      }}
      aria-busy={loading}
    >
      <Stack spacing={1.5} sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
          <Typography variant="h6">Підрозділи</Typography>
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            useFlexGap
            sx={{ flexWrap: 'wrap' }}
          >
            {showInvestigatingFilter && onToggleInvestigating ? (
              <PowerChip
                size="small"
                selected={isInvestigating}
                onClick={() => onToggleInvestigating(!isInvestigating)}
                label="В дорозвідці"
                selectedBorderColor="#b58c2f"
                selectedBackgroundColor="#3a2d11"
                selectedTextColor="#f5c84c"
                sx={{ width: 'fit-content' }}
              />
            ) : null}
            {onToggleOpen ? (
              <IconButton
                onClick={onToggleOpen}
                aria-label="Сховати панель підрозділів"
                title="Сховати панель підрозділів"
                sx={{
                  display: isDesktopLayout ? 'none' : 'inline-flex',
                  color: 'text.primary',
                }}
              >
                <KeyboardArrowUpIcon />
              </IconButton>
            ) : null}
          </Stack>
        </Stack>
        {selectedUnitFilter ? (
          <Stack spacing={0.75}>
            <Typography variant="caption" color="text.secondary">
              Активний фільтр
            </Typography>
            <PowerChip
              size="small"
              selected
              onClick={() => onPickUnitFilter(selectedUnitFilter)}
              label={
                <Stack direction="row" spacing={0.75} alignItems="center">
                  <span>{formatSelectedFilterLabel(selectedUnitFilter)}</span>
                  <ClearIcon sx={{ fontSize: 16 }} aria-hidden="true" />
                </Stack>
              }
              title="Скинути фільтр підрозділу"
              sx={{ width: 'fit-content', maxWidth: '100%' }}
            />
          </Stack>
        ) : null}
        <TextField
          size="small"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Пошук"
          disabled={loading}
          inputProps={{ 'aria-label': 'Пошук підрозділу у дереві статистики' }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
              endAdornment:
                searchInput.trim() !== '' ? (
                  <InputAdornment position="end">
                    <IconButton
                      size="small"
                      onClick={() => setSearchInput('')}
                      aria-label="Очистити пошук підрозділу"
                      edge="end"
                      disabled={loading}
                    >
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ) : undefined,
            },
          }}
        />
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <PowerChip
            size="small"
            label={
              normalizedSearchQuery === ''
                ? `Підрозділів: ${stats.length}`
                : `Підрозділів: ${filteredStats.length} з ${stats.length}`
            }
            interactive={false}
            unselectedOpacity={1}
            unselectedBackgroundColor="action.selected"
            unselectedTextColor="text.primary"
            unselectedBorderColor="transparent"
          />
          <PowerChip
            size="small"
            label={
              normalizedSearchQuery === ''
                ? `${countLabel}: ${total}`
                : `${countLabel}: ${total} з ${totalOverall}`
            }
            interactive={false}
            unselectedOpacity={1}
            unselectedBackgroundColor="transparent"
            unselectedTextColor="text.primary"
            unselectedBorderColor="divider"
          />
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {selectedUnitFilter
            ? `Натисніть на активний фільтр вище, щоб скинути його.`
            : 'Натисніть на підрозділ, щоб обрати його. Стрілка ліворуч розгортає/згортає дочірні елементи.'}
        </Typography>
      </Stack>
      {loading && stats.length === 0 ? (
        <Stack
          alignItems="center"
          justifyContent="center"
          sx={{ p: 3 }}
          role="status"
          aria-live="polite"
        >
          <CircularProgress size={24} color="primary" aria-label="Завантаження статистики" />
        </Stack>
      ) : (
        <Stack sx={{ position: 'relative', flex: 1, minHeight: 0 }}>
          <SectionLoadingOverlay
            open={loading && stats.length > 0}
            ariaLabel="Оновлення статистики"
          />

          <List
            dense
            disablePadding
            sx={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              WebkitOverflowScrolling: 'touch',
              py: 0.5,
            }}
            aria-label="Дерево підрозділів"
          >
            {tree.map((node) => (
              <UnitTreeItem
                key={node.id}
                node={node}
                depth={0}
                expandedIds={expandedIds}
                onToggle={onToggle}
                onPickUnitFilter={onPickUnitFilter}
                selectedUnitFilter={selectedUnitFilter}
                countLabel={countLabel}
              />
            ))}
            {stats.length === 0 ? (
              <Typography
                variant="body2"
                sx={{ p: 2 }}
                color="text.secondary"
                role="status"
                aria-live="polite"
              >
                Статистика відсутня
              </Typography>
            ) : filteredStats.length === 0 ? (
              <Typography
                variant="body2"
                sx={{ p: 2 }}
                color="text.secondary"
                role="status"
                aria-live="polite"
              >
                Нічого не знайдено за запитом
              </Typography>
            ) : null}
          </List>
        </Stack>
      )}
    </Paper>
  );
}
