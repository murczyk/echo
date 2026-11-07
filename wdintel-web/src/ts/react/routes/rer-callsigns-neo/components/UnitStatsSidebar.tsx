import ClearIcon from '@mui/icons-material/Clear';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import SearchIcon from '@mui/icons-material/Search';
import {
  CircularProgress,
  IconButton,
  InputAdornment,
  List,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isPresent } from '../../../utils/misc';

import { HIERARCHY_KEYS, type TreeNode } from '../../shared/unit-hierarchy';

import { UnitTreeItem } from './UnitStatsTreeItem';
import { UnitStatsCounterLegend } from './UnitStatsCounters';
import {
  buildUnitTree,
  collectExpansionPathToSelectedFilter,
  collectGroupIds,
  matchesUnitSearch,
  normalizeSearchQuery,
  reconcileUnitStats,
} from './UnitStatsSidebar.tree';
import { PowerChip } from '../../../components/PowerChip';
import { SectionLoadingOverlay } from '../../../components/SectionLoadingOverlay';
import type { SelectedSidebarUnitFilter, UnitStatView } from '../types';

type Props = {
  stats: UnitStatView[];
  cachedTree?: TreeNode[] | null;
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
  additionalFilters?: ReactNode;
};

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
const SIDEBAR_FILTER_DEBOUNCE_MS = 180;

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
  cachedTree,
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
  additionalFilters,
}: Props) {
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearchInput = useDebouncedValue(searchInput, SIDEBAR_FILTER_DEBOUNCE_MS);
  const normalizedSearchQuery = useMemo(
    () => normalizeSearchQuery(debouncedSearchInput),
    [debouncedSearchInput],
  );
  const currentStats = useMemo(() => reconcileUnitStats(stats, cachedTree), [stats, cachedTree]);
  const filteredStats = useMemo(
    () => currentStats.filter((row) => matchesUnitSearch(row, normalizedSearchQuery)),
    [currentStats, normalizedSearchQuery],
  );
  const tree = useMemo(() => buildUnitTree(filteredStats, cachedTree), [filteredStats, cachedTree]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const onToggle = useCallback((nodeId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);
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
        <div className="flex items-center gap-echo-xs">
          <Typography variant="h6">{additionalFilters ? 'Фільтри' : 'Підрозділи'}</Typography>
          {!additionalFilters ? <UnitStatsCounterLegend countLabel={countLabel} /> : null}
        </div>
        {onToggleOpen ? (
          <IconButton
            onClick={onToggleOpen}
            aria-label={
              additionalFilters ? 'Показати панель фільтрів' : 'Показати панель підрозділів'
            }
            title={additionalFilters ? 'Показати панель фільтрів' : 'Показати панель підрозділів'}
            sx={{ color: 'text.primary' }}
          >
            <KeyboardArrowDownIcon />
          </IconButton>
        ) : null}
      </Paper>
    );
  }

  return (
    <Paper
      variant="outlined"
      sx={{
        width: isDesktopLayout ? 320 : '100%',
        minWidth: isDesktopLayout ? 280 : 0,
        height: isDesktopLayout ? '100%' : 'auto',
        maxHeight: isDesktopLayout ? '100%' : additionalFilters ? '70vh' : '36vh',
        overflow: additionalFilters ? 'auto' : 'hidden',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 0,
        borderRight: '1px solid',
        borderColor: 'divider',
      }}
      aria-busy={loading}
    >
      <Stack
        spacing={1.5}
        sx={{
          p: 2,
          borderBottom: '1px solid',
          borderColor: 'divider',
          flexShrink: additionalFilters ? 0 : undefined,
        }}
      >
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
          <div className="flex items-center gap-echo-xs">
            <Typography variant="h6">{additionalFilters ? 'Фільтри' : 'Підрозділи'}</Typography>
            {!additionalFilters ? <UnitStatsCounterLegend countLabel={countLabel} /> : null}
          </div>
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
                aria-label={
                  additionalFilters ? 'Сховати панель фільтрів' : 'Сховати панель підрозділів'
                }
                title={additionalFilters ? 'Сховати панель фільтрів' : 'Сховати панель підрозділів'}
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
        {additionalFilters}
        {additionalFilters ? (
          <div className="flex items-center gap-echo-xs">
            <Typography variant="subtitle2">Підрозділи</Typography>
            <UnitStatsCounterLegend countLabel={countLabel} />
          </div>
        ) : null}
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
        <Stack sx={{ position: 'relative', flex: 1, minHeight: additionalFilters ? 160 : 0 }}>
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
