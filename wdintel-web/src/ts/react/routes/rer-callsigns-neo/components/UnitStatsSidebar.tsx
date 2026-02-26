import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Backdrop, Chip, CircularProgress, Collapse, Divider, List, ListItemButton, ListItemText, Paper, Stack, Typography } from '@mui/material';
import React from 'react';

import { loadingOverlayBackdropSx } from '../../../components/loadingOverlayStyles';
import type { UnitStatView } from '../types';

type Props = {
  stats: UnitStatView[];
  open: boolean;
  loading: boolean;
  onPickUnitFilter: (unitName: string) => void;
  selectedUnitFilter?: string;
};

type TreeLeafNode = {
  kind: 'leaf';
  id: string;
  unitId: number;
  unitName: string;
  count: number;
};

type TreeGroupNode = {
  kind: 'group';
  id: string;
  label: string;
  count: number;
  children: TreeNode[];
};

type TreeNode = TreeGroupNode | TreeLeafNode;

const HIERARCHY_LABELS = ['Армія', 'Дивізія', 'Полк', 'Батальйон'] as const;

function normalizeHierarchyPart(part: string, level: number): string {
  const value = part.trim();
  if (value !== '') return value;
  return `Без ${HIERARCHY_LABELS[level].toLowerCase()}`;
}

function buildUnitTree(stats: UnitStatView[]): TreeNode[] {
  const root: TreeNode[] = [];
  const groups = new Map<string, TreeGroupNode>();

  for (const row of stats) {
    const rawParts = [row.army, row.division, row.regiment, row.battalion];
    let parentChildren = root;
    let path: string[] = [];

    rawParts.forEach((part, level) => {
      const hasAnyDeeperPart = rawParts.slice(level).some((item) => item.trim() !== '');
      if (!hasAnyDeeperPart) return;

      const label = normalizeHierarchyPart(part, level);
      path = [...path, `${level}:${label}`];
      const id = `group:${path.join('|')}`;

      let group = groups.get(id);
      if (!group) {
        group = {
          kind: 'group',
          id,
          label,
          count: 0,
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
      unitName: row.unitName,
      count: row.count,
    });
  }

  return root;
}

function collectPathToSelectedUnit(nodes: TreeNode[], selectedUnitFilter: string): string[] {
  for (const node of nodes) {
    if (node.kind === 'leaf') {
      if (node.unitName === selectedUnitFilter) return [];
      continue;
    }

    const childPath = collectPathToSelectedUnit(node.children, selectedUnitFilter);
    if (childPath.length > 0 || node.children.some((child) => child.kind === 'leaf' && child.unitName === selectedUnitFilter)) {
      return [node.id, ...childPath];
    }
  }

  return [];
}

type TreeItemProps = {
  node: TreeNode;
  depth: number;
  expandedIds: Set<string>;
  onToggle: (nodeId: string) => void;
  onPickUnitFilter: (unitName: string) => void;
  selectedUnitFilter?: string;
};

function UnitTreeItem({ node, depth, expandedIds, onToggle, onPickUnitFilter, selectedUnitFilter }: TreeItemProps) {
  const paddingLeft = 2 + depth * 2;

  if (node.kind === 'leaf') {
    return (
      <ListItemButton
        onClick={() => onPickUnitFilter(node.unitName)}
        selected={selectedUnitFilter === node.unitName}
        sx={{ pl: paddingLeft, pr: 1.5 }}
        aria-label={`Фільтрувати за підрозділом ${node.unitName}, позивних ${node.count}`}
      >
        <ListItemText
          primary={node.unitName}
          primaryTypographyProps={{ noWrap: true, title: node.unitName }}
        />
        <Chip size="small" label={node.count} sx={{ ml: 1 }} />
      </ListItemButton>
    );
  }

  const isExpanded = expandedIds.has(node.id);

  return (
    <>
      <ListItemButton
        onClick={() => onToggle(node.id)}
        sx={{ pl: paddingLeft, pr: 1.5 }}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Згорнути' : 'Розгорнути'} ${node.label}, позивних ${node.count}`}
      >
        {isExpanded ? <ExpandMoreIcon fontSize="small" sx={{ mr: 0.5 }} /> : <ChevronRightIcon fontSize="small" sx={{ mr: 0.5 }} />}
        <ListItemText primary={node.label} primaryTypographyProps={{ noWrap: true, title: node.label }} />
        <Chip size="small" label={node.count} sx={{ ml: 1 }} />
      </ListItemButton>
      <Collapse in={isExpanded} timeout="auto" unmountOnExit>
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
            />
          ))}
        </List>
      </Collapse>
    </>
  );
}

export function UnitStatsSidebar({ stats, open, loading, onPickUnitFilter, selectedUnitFilter }: Props) {
  const tree = React.useMemo(() => buildUnitTree(stats), [stats]);
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(() => new Set());
  const total = stats.reduce((sum, row) => sum + row.count, 0);

  React.useEffect(() => {
    if (!open) return;
    const selectedUnit = selectedUnitFilter?.trim() ?? '';

    if (!selectedUnit) return;

    const path = collectPathToSelectedUnit(tree, selectedUnit);
    setExpandedIds(new Set(path));
  }, [open, tree, selectedUnitFilter]);

  if (!open) return null;

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
        width: { xs: '100%', lg: 320 },
        minWidth: { lg: 280 },
        height: { xs: 'auto', lg: '100%' },
        maxHeight: { xs: '36vh', lg: '100%' },
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
      aria-busy={loading}
    >
      <Stack spacing={1.5} sx={{ p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
          <Typography variant="h6">Підрозділи</Typography>
        </Stack>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Chip size="small" label={`Підрозділів: ${stats.length}`} />
          <Chip size="small" label={`Позивних: ${total}`} variant="outlined" />
        </Stack>
        <Typography variant="body2" color="text.secondary">
          Розгортайте групи та натискайте на підрозділ, щоб підставити його в текстовий фільтр.
        </Typography>
      </Stack>
      <Divider />
      {loading && stats.length === 0 ? (
        <Stack alignItems="center" justifyContent="center" sx={{ p: 3 }} role="status" aria-live="polite">
          <CircularProgress size={24} color="primary" aria-label="Завантаження статистики" />
        </Stack>
      ) : (
        <Stack sx={{ position: 'relative', flex: 1, minHeight: 0 }}>
          <Backdrop
            open={loading && stats.length > 0}
            sx={loadingOverlayBackdropSx}
          >
            <CircularProgress size={22} color="primary" role="status" aria-live="polite" aria-label="Оновлення статистики" />
          </Backdrop>

          <List
            dense
            disablePadding
            sx={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}
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
              />
            ))}
            {stats.length === 0 ? (
              <Typography variant="body2" sx={{ p: 2 }} color="text.secondary" role="status" aria-live="polite">
                Статистика відсутня
              </Typography>
            ) : null}
          </List>
        </Stack>
      )}
    </Paper>
  );
}
