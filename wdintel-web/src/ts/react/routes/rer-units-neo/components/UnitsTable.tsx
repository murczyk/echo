import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import CancelIcon from '@mui/icons-material/Cancel';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import MergeIcon from '@mui/icons-material/Merge';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ClearIcon from '@mui/icons-material/Clear';
import SearchIcon from '@mui/icons-material/Search';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import {
  Box,
  Chip,
  ListItemText,
  Menu,
  MenuItem,
  IconButton,
  InputAdornment,
  Link,
  Stack,
  TextField,
  Tooltip,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  type MRT_ColumnDef,
  MaterialReactTable,
  useMaterialReactTable,
} from 'material-react-table';
import { useEffect, useMemo, useState } from 'react';

import type { Unit } from '../../../../../Bindings';
import { MrtRowActionButton, MrtRowActions } from '../../../components/MrtRowActionButton';
import {
  CUSTOM_STYLES,
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../../components/mui-customized/table/custom-styles';
import {
  getDefaultMRTOptions,
  getFilterModeHelperText,
  getSharedFilterTextFieldProps,
  renderColumnActionsMenuItems,
} from '../../../components/mui-customized/table/get-default-table-options';
import { useTableStateContext } from '../../../components/mui-customized/table/table-state-provider';
import { handleNavigateWithinSpaClick } from '../../../utils/browser';
import { isUnitSearchMatch, isUnitSearchMatchForUnit, type UnitSearchMode } from '../search-mode';

const defaultMrtOptions = getDefaultMRTOptions<Unit>();
const ROW_ACTIONS_COLUMN_SIZE = 76;
const GLOBAL_SEARCH_FILTER_FN_STRICT = 'unitSearchStrictGlobal';
const COLUMN_SEARCH_FILTER_FN_STRICT = 'unitSearchStrictColumn';
const SEARCHABLE_TEXT_COLUMN_IDS = [
  'name',
  'company',
  'battalion',
  'regiment',
  'division',
  'army',
  'militaryDistrict',
  'armyRegion',
  'comment',
  'hasOrbit',
] as const;
const isColumnSearchMatch = (rowValue: unknown, filterValue: unknown) => {
  if (typeof filterValue !== 'string' || filterValue.trim() === '') return true;
  return isUnitSearchMatch(String(rowValue ?? ''), filterValue);
};

const isGlobalSearchMatch = (rowValue: Unit, filterValue: unknown) => {
  if (typeof filterValue !== 'string' || filterValue.trim() === '') return true;
  return isUnitSearchMatchForUnit(rowValue, filterValue);
};

function SearchModeSettingsButton({
  compact,
  searchMode,
  onSearchModeChange,
  menuId,
}: {
  compact: boolean;
  searchMode: UnitSearchMode;
  onSearchModeChange: (searchMode: UnitSearchMode) => void;
  menuId: string;
}) {
  const [anchorElement, setAnchorElement] = useState<HTMLElement | null>(null);
  const menuOpen = Boolean(anchorElement);

  const closeMenu = () => {
    setAnchorElement(null);
  };

  const changeMode = (mode: UnitSearchMode) => {
    onSearchModeChange(mode);
    closeMenu();
  };

  return (
    <>
      <IconButton
        size="small"
        aria-label="Налаштування пошуку"
        aria-controls={menuOpen ? menuId : undefined}
        aria-haspopup="menu"
        aria-expanded={menuOpen ? 'true' : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setAnchorElement(event.currentTarget);
        }}
        sx={{
          width: compact ? 40 : 32,
          height: compact ? 40 : 32,
          borderRadius: 1,
          border: '1px solid',
          borderColor: 'divider',
          color: 'text.secondary',
        }}
      >
        <SettingsOutlinedIcon sx={{ fontSize: compact ? 20 : 18 }} />
      </IconButton>
      <Menu
        id={menuId}
        anchorEl={anchorElement}
        open={menuOpen}
        onClose={closeMenu}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ list: { 'aria-label': 'Налаштування пошуку' } }}
      >
        <MenuItem
          role="menuitemradio"
          aria-checked={searchMode === 'strict'}
          selected={searchMode === 'strict'}
          onClick={() => changeMode('strict')}
        >
          <ListItemText>Строгий пошук</ListItemText>
        </MenuItem>
        <MenuItem
          role="menuitemradio"
          aria-checked={searchMode === 'relaxed'}
          selected={searchMode === 'relaxed'}
          onClick={() => changeMode('relaxed')}
        >
          <ListItemText>Нечіткий пошук</ListItemText>
        </MenuItem>
      </Menu>
    </>
  );
}

const TEXT_FILTER_HELPERS: Record<UnitSearchMode, string> = {
  strict: 'Режим: строгий',
  relaxed: 'Режим: нечіткий',
};

function getColumnFilterFn(searchMode: UnitSearchMode): string {
  return searchMode === 'strict' ? COLUMN_SEARCH_FILTER_FN_STRICT : 'fuzzy';
}

function buildTextColumnFilter({
  searchMode,
  onSearchModeChange,
  compactSearchMode,
  menuIdPrefix,
}: {
  searchMode: UnitSearchMode;
  onSearchModeChange: (searchMode: UnitSearchMode) => void;
  compactSearchMode: boolean;
  menuIdPrefix: string;
}) {
  return ({ column }) => {
    const sharedFilterProps = getSharedFilterTextFieldProps(column.columnDef.filterVariant);
    const filterValue = column.getFilterValue();
    const inputValue = typeof filterValue === 'string' ? filterValue : '';

    return (
      <TextField
        fullWidth
        size="small"
        variant="standard"
        value={inputValue}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onChange={(event) => column.setFilterValue(event.target.value)}
        placeholder="Пошук"
        helperText={TEXT_FILTER_HELPERS[searchMode]}
        slotProps={{
          ...(sharedFilterProps.slotProps ?? {}),
          input: {
            ...(sharedFilterProps.slotProps?.input ?? {}),
            autoComplete: 'new-password',
            readOnly: false,
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ color: 'text.secondary', fontSize: 18 }} />
              </InputAdornment>
            ),
            endAdornment: (
              <InputAdornment position="end" sx={{ gap: 0.75 }}>
                <SearchModeSettingsButton
                  compact={compactSearchMode}
                  searchMode={searchMode}
                  onSearchModeChange={onSearchModeChange}
                  menuId={`column-search-mode-${menuIdPrefix}`}
                />
                <IconButton
                  size="small"
                  aria-label="Очистити фільтр"
                  onClick={(event) => {
                    event.stopPropagation();
                    column.setFilterValue('');
                  }}
                  disabled={inputValue.length === 0}
                >
                  <ClearIcon sx={{ color: 'text.secondary', fontSize: 18 }} />
                </IconButton>
              </InputAdornment>
            ),
          },
        }}
        sx={{
          ...sharedFilterProps.sx,
          '& .MuiInput-root': {
            ...(sharedFilterProps.sx?.['& .MuiInput-root'] ?? {}),
            pb: 0.75,
          },
        }}
      />
    );
  };
}

function formatDateTime(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('uk-UA', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function OrbitCell({ unit }: { unit: Unit }) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%', minWidth: 0 }}>
      {unit.hasOrbit ? (
        <CheckCircleIcon
          className="text-green-600"
          fontSize="small"
          titleAccess="Прив’язано до Orbit"
          sx={{ flexShrink: 0 }}
        />
      ) : (
        <CancelIcon
          className="text-red-600"
          fontSize="small"
          titleAccess="Не прив’язано до Orbit"
          sx={{ flexShrink: 0 }}
        />
      )}
      {unit.orbitUnitIds.map((orbitUnitId) => (
        <Tooltip key={orbitUnitId} title="Відкрити підрозділ в Orbit">
          <Link
            href={`https://delta.mil.gov.ua/orbit/units/${orbitUnitId}/organizational-structure`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Відкрити ${unit.name} в Orbit`}
            sx={{ display: 'flex', flexShrink: 0 }}
          >
            <Box component="img" src="/img/delta-icon.webp" alt="" sx={{ width: 22, height: 22 }} />
          </Link>
        </Tooltip>
      ))}
      {unit.orbitNote ? (
        <Tooltip title={<Box sx={{ whiteSpace: 'pre-wrap' }}>{unit.orbitNote}</Box>}>
          <Box
            component="span"
            sx={{
              minWidth: 0,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {unit.orbitNote}
          </Box>
        </Tooltip>
      ) : null}
    </Stack>
  );
}

function useUnitColumns(
  attachmentUnitIds: Set<number>,
  searchMode: UnitSearchMode,
  onSearchModeChange: (searchMode: UnitSearchMode) => void,
  compactSearchMode: boolean,
): MRT_ColumnDef<Unit>[] {
  return useMemo(
    () => [
      {
        header: 'Назва',
        accessorKey: 'name',
        filterFn: getColumnFilterFn(searchMode),
        Filter: buildTextColumnFilter({
          searchMode,
          onSearchModeChange,
          compactSearchMode,
          menuIdPrefix: 'name',
        }),
        size: 240,
        muiTableBodyCellProps: {
          sx: {
            ...CUSTOM_STYLES.muiTableBodyCellProps.sx,
            overflow: 'hidden',
            verticalAlign: 'middle',
          },
        },
        Cell: ({ row }) => {
          const detailsHref = `/rer-units/${row.original.id}`;
          const filesHref = `${detailsHref}?tab=files`;
          return (
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              useFlexGap
              sx={{ minWidth: 0, width: '100%' }}
            >
              <Tooltip title={row.original.active ? 'Активний' : 'Неактивний'}>
                <Box
                  sx={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    bgcolor: row.original.active ? '#54c06c' : '#bfbfbf',
                    flexShrink: 0,
                  }}
                />
              </Tooltip>
              <Tooltip title={row.original.name}>
                <Link
                  href={detailsHref}
                  onClick={(event) => handleNavigateWithinSpaClick(event, detailsHref)}
                  sx={{
                    display: 'block',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {row.original.name}
                </Link>
              </Tooltip>
              {row.original.isDeduplicateCandidate === true ? (
                <Tooltip title="можливо дублікат, перевірте">
                  <WarningAmberIcon color="warning" fontSize="small" />
                </Tooltip>
              ) : null}
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ ml: 'auto', flexShrink: 0 }}
              >
                {attachmentUnitIds.has(row.original.id) ? (
                  <Tooltip title="Відкрити файли підрозділу">
                    <Link
                      href={filesHref}
                      underline="none"
                      onClick={(event) => handleNavigateWithinSpaClick(event, filesHref)}
                      aria-label={`Відкрити файли підрозділу ${row.original.name}`}
                    >
                      <Chip
                        component="span"
                        icon={<AttachFileIcon />}
                        label="Файли"
                        size="small"
                        color="primary"
                        variant="outlined"
                      />
                    </Link>
                  </Tooltip>
                ) : null}
              </Stack>
            </Stack>
          );
        },
      },
      {
        header: 'Рота/Взвод',
        accessorKey: 'company',
        filterFn: getColumnFilterFn(searchMode),
        Filter: buildTextColumnFilter({
          searchMode,
          onSearchModeChange,
          compactSearchMode,
          menuIdPrefix: 'company',
        }),
        size: 160,
      },
      {
        header: 'Батальйон',
        accessorKey: 'battalion',
        filterFn: getColumnFilterFn(searchMode),
        Filter: buildTextColumnFilter({
          searchMode,
          onSearchModeChange,
          compactSearchMode,
          menuIdPrefix: 'battalion',
        }),
        size: 160,
      },
      {
        header: 'Полк/Бригада',
        accessorKey: 'regiment',
        filterFn: getColumnFilterFn(searchMode),
        Filter: buildTextColumnFilter({
          searchMode,
          onSearchModeChange,
          compactSearchMode,
          menuIdPrefix: 'regiment',
        }),
        size: 180,
      },
      {
        header: 'Дивізія',
        accessorKey: 'division',
        filterFn: getColumnFilterFn(searchMode),
        Filter: buildTextColumnFilter({
          searchMode,
          onSearchModeChange,
          compactSearchMode,
          menuIdPrefix: 'division',
        }),
        size: 160,
      },
      {
        header: 'Корпус/Армія',
        accessorKey: 'army',
        filterFn: getColumnFilterFn(searchMode),
        Filter: buildTextColumnFilter({
          searchMode,
          onSearchModeChange,
          compactSearchMode,
          menuIdPrefix: 'army',
        }),
        size: 180,
      },
      {
        header: 'Група армій/Фронт/Види та роди ЗС',
        accessorKey: 'militaryDistrict',
        filterFn: getColumnFilterFn(searchMode),
        Filter: buildTextColumnFilter({
          searchMode,
          onSearchModeChange,
          compactSearchMode,
          menuIdPrefix: 'military-district',
        }),
        size: 280,
      },
      {
        header: 'Регіон/ТВД/Збройні Сили',
        accessorKey: 'armyRegion',
        filterFn: getColumnFilterFn(searchMode),
        Filter: buildTextColumnFilter({
          searchMode,
          onSearchModeChange,
          compactSearchMode,
          menuIdPrefix: 'army-region',
        }),
        size: 220,
      },
      {
        header: 'Створено',
        id: 'createdAt',
        accessorFn: (unit) => formatDateTime(unit.createdAt),
        sortingFn: (left, right) => left.original.createdAt - right.original.createdAt,
        sortDescFirst: true,
        size: 160,
        Cell: ({ row }) => formatDateTime(row.original.createdAt),
      },
      {
        header: 'Коментар',
        accessorKey: 'comment',
        filterFn: getColumnFilterFn(searchMode),
        Filter: buildTextColumnFilter({
          searchMode,
          onSearchModeChange,
          compactSearchMode,
          menuIdPrefix: 'comment',
        }),
        size: 300,
        Cell: ({ cell }) => (
          <Box sx={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
            {String(cell.getValue() ?? '')}
          </Box>
        ),
      },
      {
        header: 'Orbit',
        Header: () => (
          <Tooltip title="Індикатор чи є дані підрозділу синхронізовані із модулем Orbit системи Delta для роботи із даними про підрозділи противника.">
            <Box component="span">Orbit</Box>
          </Tooltip>
        ),
        id: 'hasOrbit',
        accessorFn: (unit) => unit.orbitNote ?? '',
        filterFn: getColumnFilterFn(searchMode),
        Filter: buildTextColumnFilter({
          searchMode,
          onSearchModeChange,
          compactSearchMode,
          menuIdPrefix: 'orbit',
        }),
        size: 170,
        Cell: ({ row }) => <OrbitCell unit={row.original} />,
      },
    ],
    [attachmentUnitIds, searchMode, onSearchModeChange, compactSearchMode],
  );
}

export function UnitsTable({
  units,
  attachmentUnitIds,
  loading,
  canEdit,
  actionInFlight,
  onEdit,
  onDelete,
  onMerge,
  searchMode,
  onSearchModeChange,
}: {
  units: Unit[];
  attachmentUnitIds: Set<number>;
  loading: boolean;
  canEdit: boolean;
  actionInFlight: boolean;
  onEdit: (unit: Unit) => void;
  onDelete: (unit: Unit) => void;
  onMerge: (unit: Unit) => void;
  searchMode: UnitSearchMode;
  onSearchModeChange: (searchMode: UnitSearchMode) => void;
}) {
  const tableStateContext = useTableStateContext();
  const theme = useTheme();
  const isSmallScreen = useMediaQuery(theme.breakpoints.down('lg'));
  const columns = useUnitColumns(attachmentUnitIds, searchMode, onSearchModeChange, isSmallScreen);
  const table = useMaterialReactTable({
    ...defaultMrtOptions,
    columns,
    data: units,
    enableSorting: true,
    enableColumnActions: true,
    enableGlobalFilter: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    enableRowActions: canEdit,
    positionActionsColumn: canEdit ? 'first' : undefined,
    columnFilterDisplayMode: 'popover',
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onSortingChange: tableStateContext.onSortingChange,
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
    filterFns: {
      [GLOBAL_SEARCH_FILTER_FN_STRICT]: (row, _columnId, filterValue) =>
        isGlobalSearchMatch(row.original, filterValue),
      [COLUMN_SEARCH_FILTER_FN_STRICT]: (row, columnId, filterValue) =>
        isColumnSearchMatch(row.getValue(columnId), filterValue),
    },
    globalFilterFn: searchMode === 'strict' ? GLOBAL_SEARCH_FILTER_FN_STRICT : 'fuzzy',
    muiFilterTextFieldProps: ({ column }) => ({
      ...getSharedFilterTextFieldProps(column.columnDef.filterVariant),
      helperText: getFilterModeHelperText(column.columnDef.filterVariant),
    }),
    defaultColumn: {
      size: 180,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: ROW_ACTIONS_COLUMN_SIZE,
        minSize: ROW_ACTIONS_COLUMN_SIZE,
        maxSize: ROW_ACTIONS_COLUMN_SIZE,
      },
    },
    renderRowActions: ({ row }) => (
      <Box sx={{ display: 'flex', justifyContent: 'center', gap: 0.5 }}>
        <MrtRowActionButton
          label="Редагувати"
          onClick={() => onEdit(row.original)}
          disabled={actionInFlight}
          icon={<EditIcon fontSize="small" />}
          opensModal
        />
        <MrtRowActions>
          <MrtRowActionButton
            label="Об’єднати дублікати"
            onClick={() => onMerge(row.original)}
            disabled={actionInFlight}
            icon={<MergeIcon fontSize="small" />}
            tone="warning"
            opensModal
          />
          <MrtRowActionButton
            label="Видалити"
            onClick={() => onDelete(row.original)}
            disabled={actionInFlight}
            icon={<DeleteIcon fontSize="small" />}
            tone="danger"
            opensModal
          />
        </MrtRowActions>
      </Box>
    ),
    muiTablePaperProps: ({ table }) =>
      getDefaultMrtPaperProps({ table, loading, layout: 'workspace' }),
    muiTableContainerProps: getDefaultMrtContainerProps({
      loading,
      layout: 'workspace',
      hasRows: units.length > 0,
    }),
    muiTableBodyCellProps: {
      sx: {
        ...CUSTOM_STYLES.muiTableBodyCellProps.sx,
        verticalAlign: 'top',
      },
    },
    state: {
      isLoading: loading,
      showLoadingOverlay: false,
      showSkeletons: loading,
      globalFilter: tableStateContext.globalFilter,
      columnFilters: tableStateContext.columnFilters,
      sorting: tableStateContext.sorting,
      columnOrder: tableStateContext.columnOrder,
      columnSizing: tableStateContext.columnSizing,
      columnVisibility: tableStateContext.columnVisibility,
    },
  });

  useEffect(() => {
    const columnSearchFilterFn = getColumnFilterFn(searchMode);
    table._getFilteredRowModel = undefined;
    table.setGlobalFilterFn(searchMode === 'strict' ? GLOBAL_SEARCH_FILTER_FN_STRICT : 'fuzzy');
    table.setColumnFilterFns((previousColumnFilterFns) => {
      const nextColumnFilterFns = { ...previousColumnFilterFns };

      SEARCHABLE_TEXT_COLUMN_IDS.forEach((columnId) => {
        nextColumnFilterFns[columnId] = columnSearchFilterFn;
      });

      return nextColumnFilterFns;
    });
  }, [searchMode, table]);

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}
