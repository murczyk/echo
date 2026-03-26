import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import {
  Alert,
  Autocomplete,
  Box,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Tab,
  Switch,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  MRT_ColumnDef,
  MRT_RowData,
  MRT_SortingState,
  MRT_ShowHideColumnsButton,
  MRT_TableInstance,
  MRT_ToggleDensePaddingButton,
  MaterialReactTable,
  useMaterialReactTable,
} from 'material-react-table';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import {
  AreaOfResponsibility,
  Datasource,
  OrphanSignalGroupEntry,
  SigintZone,
  SignalGroupEntry,
  ZoneDatasourceGroup,
  ZoneDatasourceGroupAddReq,
  ZoneDatasourceGroupUpdateReq,
} from '../../../../Bindings';
import { MrtRowActionButton, MrtRowActions, mrtRowActionsColumnSize } from '../../components/MrtRowActionButton';
import { PageErrorState } from '../../components/PageErrorState';
import { SectionEmptyState } from '../../components/SectionEmptyState';
import { SectionLoadingOverlay } from '../../components/SectionLoadingOverlay';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../components/dialogStyles';
import { GlobalFilterTextField } from '../../components/mui-customized/table/components/table-top-toolbar/components/global-filter-text-field';
import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { Button } from '../../components/mui-customized/button';
import { PowerChip } from '../../components/PowerChip';
import {
  CUSTOM_STYLES,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../components/mui-customized/table/custom-styles';
import {
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import { listAors } from '../../services/api/aor';
import { listLogins } from '../../services/api/logins';
import { editGroup } from '../../services/api/messenger';
import {
  addZoneDatasourceGroup,
  deleteZoneDatasourceGroup,
  fetchSignalGroupInfoBatch,
  listDatasources,
  listOrphanSignalGroups,
  listSigintZones,
  listZoneDatasourceGroups,
  listZoneDatasources,
  updateZoneDatasourceGroup,
} from '../../services/api/zones';
import { formatDate } from '../../utils/misc';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

type DatasourceEntry = [number, Datasource];
type ZoneEntry = [number, SigintZone];
type ZoneGroupRow = {
  id: string;
  zoneId: number;
  datasourceId: number;
  group: ZoneDatasourceGroup;
};

type OrphanAssignState = {
  group: OrphanSignalGroupEntry;
  selectedZones: ZoneEntry[];
  isSecret: boolean;
  selectedUsers: string[];
  isSaving: boolean;
  error: string | null;
};

type GroupEditState = {
  zoneId: number;
  datasourceId: number;
  group: ZoneDatasourceGroup;
  groupName: string;
  isSecret: boolean;
  selectedUsers: string[];
  shortNote: string;
  longNote: string;
  selectedAorIds: number[];
  isSaving: boolean;
  error: string | null;
};

type OrphanEditState = {
  group: OrphanSignalGroupEntry;
  groupName: string;
  shortNote: string;
  longNote: string;
  selectedAorIds: number[];
  isSaving: boolean;
  error: string | null;
};

type DeleteState = {
  zoneId: number;
  datasourceId: number;
  group: ZoneDatasourceGroup;
  groupName: string;
  isDeleting: boolean;
  error: string | null;
};

const DEFAULT_ORPHAN_COLUMNS_VISIBILITY = {
  group: true,
  datasource: true,
  activityDay: true,
  activityWeek: true,
  aors: true,
  notes: true,
  createdAt: true,
};

const DEFAULT_ORPHAN_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'group',
  'datasource',
  'activityDay',
  'activityWeek',
  'aors',
  'notes',
  'createdAt',
];

const DEFAULT_ZONE_COLUMNS_VISIBILITY = {
  group: true,
  datasource: true,
  activityDay: true,
  activityWeek: true,
  access: true,
  aors: true,
  notes: true,
};

const DEFAULT_ZONE_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'group',
  'datasource',
  'activityDay',
  'activityWeek',
  'access',
  'aors',
  'notes',
];

const DEFAULT_ACTIVITY_DAY_SORTING: MRT_SortingState = [
  { id: 'activityDay', desc: true },
];
const EMPTY_AOR_FILTER_VALUE = '—';
const EMPTY_AOR_FILTER_LABEL = '—';

const orphanDefaultMRTOptions = getDefaultMRTOptions<OrphanSignalGroupEntry>();
const zoneDefaultMRTOptions = getDefaultMRTOptions<ZoneGroupRow>();
const ORPHAN_GLOBAL_FILTER_COLUMN_IDS = new Set([
  'group',
  'datasource',
  'aors',
  'notes',
  'createdAt',
]);
const ZONE_GLOBAL_FILTER_COLUMN_IDS = new Set([
  'group',
  'datasource',
  'access',
  'aors',
  'notes',
]);
const LOADING_SKELETON_ROW_COUNT = 16;

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

function formatOptionalText(value: string | null | undefined): string {
  if (!value || !value.trim()) return '—';
  return value;
}

function buildGroupKey(zoneId: number, datasourceId: number): string {
  return `${zoneId}:${datasourceId}`;
}

function getGroupName(
  groupKey: string,
  fallbackName: string | null | undefined,
  groupInfos: Map<string, SignalGroupEntry>
) {
  const info = groupInfos.get(groupKey);
  if (info && info.name.trim()) return info.name;
  if (fallbackName && fallbackName.trim()) return fallbackName;
  return groupKey.slice(-5);
}

function getDatasourceLabel(
  datasourceId: number | null,
  datasourceById: Map<number, Datasource>
) {
  if (datasourceId === null) return '—';
  const datasource = datasourceById.get(datasourceId);
  return datasource?.displayName || `#${datasourceId}`;
}

function buildAorLabels(
  aors: AreaOfResponsibility[] | null | undefined
): string {
  if (!aors || aors.length === 0) return '—';
  return aors.map((aor) => aor.name).join(', ');
}

function buildAorNames(
  aors: AreaOfResponsibility[] | null | undefined
): string[] {
  if (!aors || aors.length === 0) return [EMPTY_AOR_FILTER_VALUE];
  return aors.map((aor) => aor.name);
}

function buildAorFilterOptions(
  aors: AreaOfResponsibility[]
): { text: string; value: string }[] {
  const uniqueNames = Array.from(new Set(aors.map((aor) => aor.name)));
  return [
    { text: EMPTY_AOR_FILTER_LABEL, value: EMPTY_AOR_FILTER_VALUE },
    ...uniqueNames.map((name) => ({ text: name, value: name })),
  ];
}

function buildOrphanLoadingRows(): OrphanSignalGroupEntry[] {
  return Array.from({ length: LOADING_SKELETON_ROW_COUNT }, (_, index) => ({
    masterKey: `loading-orphan-${index}`,
    name: '',
    datasourceId: null,
    ignoreOperativny: false,
    groupStats: {
      activityLastDay: 0,
      activityLastWeek: 0,
    },
    groupAdminData: null,
    areasOfResponsibility: null,
    createdAt: 0,
  }));
}

function buildZoneLoadingRows(): ZoneGroupRow[] {
  return Array.from({ length: LOADING_SKELETON_ROW_COUNT }, (_, index) => ({
    id: `loading-zone-${index}`,
    zoneId: 0,
    datasourceId: 0,
    group: {
      sigintZoneDatasourceId: index,
      sigintZoneId: 0,
      datasourceId: 0,
      groupMasterKey: '',
      isGroupSecret: false,
      allowedUsers: [],
      areaOfResponsibilityId: null,
      areasOfResponsibility: null,
      shortNote: null,
      longNote: null,
    },
  }));
}

function TableTabControls<TData extends MRT_RowData>(props: {
  globalFilter: string;
  onGlobalFilterChange: (value: string) => void;
  table: MRT_TableInstance<TData>;
  disabled?: boolean;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1,
        pb: 2,
        flexShrink: 0,
      }}
    >
      <Box sx={{ width: { xs: '100%', sm: 360 }, maxWidth: '100%' }}>
        <GlobalFilterTextField
          className="!min-w-0 !w-full"
          globalFilter={props.globalFilter}
          setGlobalFilter={props.onGlobalFilterChange}
          disabled={props.disabled}
        />
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <MRT_ShowHideColumnsButton table={props.table} disabled={props.disabled} />
        <MRT_ToggleDensePaddingButton table={props.table} disabled={props.disabled} />
      </Box>
    </Box>
  );
}

function OrphanGroupsTable(props: {
  data: OrphanSignalGroupEntry[];
  loading?: boolean;
  datasourceById: Map<number, Datasource>;
  aorFilterOptions: { text: string; value: string }[];
  onAssign: (group: OrphanSignalGroupEntry) => void;
  onEdit: (group: OrphanSignalGroupEntry) => void;
}) {
  const tableStateContext = useTableStateContext();
  const isLoading = Boolean(props.loading);

  const columns = useMemo<MRT_ColumnDef<OrphanSignalGroupEntry>[]>(
    () => [
      {
        header: 'Група',
        id: 'group',
        accessorFn: (row) => {
          if (!row?.masterKey) return '—';
          return row.name && row.name.trim() ? row.name : row.masterKey.slice(-5);
        },
        Cell: ({ row }) => {
          if (isLoading || !row.original?.masterKey) return <span>—</span>;
          const name =
            row.original.name && row.original.name.trim()
              ? row.original.name
              : row.original.masterKey.slice(-5);
          return (
            <Tooltip title={name}>
              <span>{name}</span>
            </Tooltip>
          );
        },
        size: 220,
      },
      {
        header: 'Джерело',
        id: 'datasource',
        accessorFn: (row) =>
          getDatasourceLabel(row?.datasourceId ?? null, props.datasourceById),
        size: 180,
      },
      {
        header: 'Активність (день)',
        id: 'activityDay',
        accessorFn: (row) => row?.groupStats?.activityLastDay ?? null,
        Cell: ({ row }) => (
          <span>{row.original?.groupStats?.activityLastDay ?? '—'}</span>
        ),
        size: 140,
      },
      {
        header: 'Активність (тиждень)',
        id: 'activityWeek',
        accessorFn: (row) => row?.groupStats?.activityLastWeek ?? null,
        Cell: ({ row }) => (
          <span>{row.original?.groupStats?.activityLastWeek ?? '—'}</span>
        ),
        size: 140,
      },
      {
        header: 'Смуги',
        id: 'aors',
        accessorFn: (row) => buildAorNames(row?.areasOfResponsibility),
        Cell: ({ row }) => {
          const label = buildAorLabels(row.original?.areasOfResponsibility);
          return (
            <Tooltip title={label}>
              <span>{label}</span>
            </Tooltip>
          );
        },
        filterVariant: 'multi-select',
        filterSelectOptions: props.aorFilterOptions,
        filterFn: 'arrIncludesSome',
        size: 240,
      },
      {
        header: 'Нотатки',
        id: 'notes',
        accessorFn: (row) => {
          const shortNote = row?.groupAdminData?.shortNote ?? '';
          const longNote = row?.groupAdminData?.longNote ?? '';
          return (
            `${shortNote}${longNote ? ` / ${longNote}` : ''}`.trim() || '—'
          );
        },
        Cell: ({ row }) => {
          const shortNote = formatOptionalText(
            row.original?.groupAdminData?.shortNote ?? null
          );
          const longNote = formatOptionalText(
            row.original?.groupAdminData?.longNote ?? null
          );
          if (shortNote === '—' && longNote === '—') return <span>—</span>;
          return (
            <div className="flex flex-col">
              {shortNote !== '—' ? <span>{shortNote}</span> : null}
              {longNote !== '—' ? (
                <span className="text-muted-foreground text-xs">
                  {longNote}
                </span>
              ) : null}
            </div>
          );
        },
        size: 260,
      },
      {
        header: 'Створено',
        id: 'createdAt',
        accessorFn: (row) => row?.createdAt ?? null,
        Cell: ({ row }) => <span>{row.original?.createdAt ? formatDate(row.original.createdAt) : '—'}</span>,
        size: 140,
      },
    ],
    [isLoading, props.datasourceById, props.aorFilterOptions]
  );

  const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
  const resolvedPaperProps =
    typeof basePaperProps === 'function'
      ? basePaperProps
      : () => basePaperProps || {};

  const state = {
    showAlertBanner: false,
    showLoadingOverlay: false,
    showSkeletons: Boolean(props.loading),
    globalFilter: tableStateContext.globalFilter,
    columnVisibility: tableStateContext.columnVisibility,
    columnFilters: tableStateContext.columnFilters,
    density: tableStateContext.density,
    sorting: tableStateContext.sorting,
    columnOrder: tableStateContext.columnOrder,
    columnSizing: tableStateContext.columnSizing,
  };

  const table = useMaterialReactTable({
    columns,
    data: isLoading ? buildOrphanLoadingRows() : props.data,
    ...orphanDefaultMRTOptions,
    enableSorting: true,
    enableColumnActions: true,
    enableGlobalFilter: true,
    enableHiding: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowVirtualization: false,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    columnFilterDisplayMode: 'popover',
    globalFilterFn: 'contains',
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onSortingChange: tableStateContext.onSortingChange,
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
    onDensityChange: tableStateContext.setDensity,
    getColumnCanGlobalFilter: (column) =>
      ORPHAN_GLOBAL_FILTER_COLUMN_IDS.has(column.id),
    enableRowActions: true,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) =>
      isLoading || !row.original?.masterKey ? null : (
        <MrtRowActions>
          <MrtRowActionButton
            label="Додати до напрямку"
            onClick={() => props.onAssign(row.original)}
            icon={<AddCircleOutlineIcon fontSize="small" />}
          />
          <MrtRowActionButton
            label="Редагувати"
            onClick={() => props.onEdit(row.original)}
            icon={<EditIcon fontSize="small" />}
          />
        </MrtRowActions>
      ),
    defaultColumn: {
      size: 200,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: mrtRowActionsColumnSize(2),
      },
    },
    muiTablePaperProps: ({ table }) => {
      const baseProps = resolvedPaperProps({ table });
      return {
        ...baseProps,
        sx: {
          ...(baseProps as any)?.sx,
          ...FULL_WIDTH_TABLE_PAPER_SX,
          height: isLoading ? '100%' : 'auto',
          minHeight: isLoading ? '100%' : undefined,
          maxHeight: '100%',
        },
      };
    },
    muiTableContainerProps: {
      sx: {
        ...(CUSTOM_STYLES.muiTableContainerProps as any)?.sx,
        ...getPageScrollTableContainerSx({
          loading: isLoading,
          height: isLoading ? '100%' : 'auto',
          minHeight: isLoading ? '100%' : undefined,
          maxHeight: '100%',
          idleOverflow: 'auto',
        }),
      },
    },
    state,
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return (
    <Box
      sx={{
        display: 'flex',
        width: '100%',
        flex: isLoading ? 1 : undefined,
        minHeight: 0,
        minWidth: 0,
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <TableTabControls
        globalFilter={tableStateContext.globalFilter}
        onGlobalFilterChange={(value) =>
          tableStateContext.onChangeGlobalFilter(value)
        }
        table={table}
        disabled={isLoading}
      />
      <Box
        sx={{
          width: '100%',
          minHeight: 0,
          minWidth: 0,
          overflow: 'hidden',
          maxHeight: '100%',
          flex: isLoading ? 1 : undefined,
          position: 'relative',
          cursor: isLoading ? 'progress' : undefined,
        }}
      >
        {isLoading ? (
          <SectionLoadingOverlay
            open
            ariaLabel="Завантаження таблиці напрямків"
            spinnerMode="center"
            sx={{ zIndex: 12 }}
          />
        ) : null}
        <MaterialReactTable table={table} />
      </Box>
    </Box>
  );
}

function ZoneGroupsTable(props: {
  rows: ZoneGroupRow[];
  loading?: boolean;
  datasourceById: Map<number, Datasource>;
  groupInfos: Map<string, SignalGroupEntry>;
  aorFilterOptions: { text: string; value: string }[];
  onEdit: (
    zoneId: number,
    datasourceId: number,
    group: ZoneDatasourceGroup
  ) => void;
  onDelete: (
    zoneId: number,
    datasourceId: number,
    group: ZoneDatasourceGroup
  ) => void;
}) {
  const tableStateContext = useTableStateContext();
  const isLoading = Boolean(props.loading);

  const columns = useMemo<MRT_ColumnDef<ZoneGroupRow>[]>(
    () => [
      {
        header: 'Група',
        id: 'group',
        accessorFn: (row) =>
          row?.group?.groupMasterKey
            ? getGroupName(row.group.groupMasterKey, null, props.groupInfos)
            : '—',
        Cell: ({ row }) => {
          if (isLoading || !row.original?.group?.groupMasterKey) return <span>—</span>;
          const groupName = getGroupName(
            row.original.group.groupMasterKey,
            null,
            props.groupInfos
          );
          return (
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <Tooltip title={groupName}>
                  <span>{groupName}</span>
                </Tooltip>
                {row.original.group.isGroupSecret ? (
                  <PowerChip
                    size="small"
                    label="прихована"
                    interactive={false}
                    unselectedOpacity={1}
                    unselectedBackgroundColor="warning.main"
                    unselectedTextColor="warning.contrastText"
                    unselectedBorderColor="warning.main"
                  />
                ) : null}
              </div>
            </div>
          );
        },
        size: 240,
      },
      {
        header: 'Джерело',
        id: 'datasource',
        accessorFn: (row) =>
          getDatasourceLabel(row?.datasourceId ?? null, props.datasourceById),
        size: 200,
      },
      {
        header: 'Активність (день)',
        id: 'activityDay',
        accessorFn: (row) => {
          const stats = row?.group?.groupMasterKey
            ? props.groupInfos.get(row.group.groupMasterKey)?.groupStats
            : null;
          return stats ? stats.activityLastDay : null;
        },
        Cell: ({ row }) => {
          const stats = row.original?.group?.groupMasterKey
            ? props.groupInfos.get(row.original.group.groupMasterKey)?.groupStats
            : null;
          if (!stats) return <span>—</span>;
          return <span>{stats.activityLastDay}</span>;
        },
        size: 140,
      },
      {
        header: 'Активність (тиждень)',
        id: 'activityWeek',
        accessorFn: (row) => {
          const stats = row?.group?.groupMasterKey
            ? props.groupInfos.get(row.group.groupMasterKey)?.groupStats
            : null;
          return stats ? stats.activityLastWeek : null;
        },
        Cell: ({ row }) => {
          const stats = row.original?.group?.groupMasterKey
            ? props.groupInfos.get(row.original.group.groupMasterKey)?.groupStats
            : null;
          if (!stats) return <span>—</span>;
          return <span>{stats.activityLastWeek}</span>;
        },
        size: 140,
      },
      {
        header: 'Доступ',
        id: 'access',
        accessorFn: (row) =>
          row?.group?.allowedUsers?.length > 0
            ? row.group.allowedUsers.join(', ')
            : 'без обмежень',
        Cell: ({ row }) => {
          const label =
            row.original?.group?.allowedUsers?.length > 0
              ? row.original.group.allowedUsers.join(', ')
              : 'без обмежень';
          return (
            <Tooltip title={label}>
              <span>{label}</span>
            </Tooltip>
          );
        },
        size: 220,
      },
      {
        header: 'Смуги',
        id: 'aors',
        accessorFn: (row) => buildAorNames(row?.group?.areasOfResponsibility),
        Cell: ({ row }) => {
          const label = buildAorLabels(
            row.original?.group?.areasOfResponsibility
          );
          return (
            <Tooltip title={label}>
              <span>{label}</span>
            </Tooltip>
          );
        },
        filterVariant: 'multi-select',
        filterSelectOptions: props.aorFilterOptions,
        filterFn: 'arrIncludesSome',
        size: 240,
      },
      {
        header: 'Нотатки',
        id: 'notes',
        accessorFn: (row) => {
          const shortNote = formatOptionalText(row?.group?.shortNote ?? null);
          const longNote = formatOptionalText(row?.group?.longNote ?? null);
          if (shortNote === '—' && longNote === '—') return '—';
          if (shortNote === '—') return longNote;
          if (longNote === '—') return shortNote;
          return `${shortNote} / ${longNote}`;
        },
        Cell: ({ row }) => {
          const shortNote = formatOptionalText(
            row.original?.group?.shortNote ?? null
          );
          const longNote = formatOptionalText(
            row.original?.group?.longNote ?? null
          );
          if (shortNote === '—' && longNote === '—') return <span>—</span>;
          const tooltipLabel =
            shortNote === '—'
              ? longNote
              : longNote === '—'
              ? shortNote
              : `${shortNote} / ${longNote}`;
          return (
            <Tooltip title={tooltipLabel}>
              <div className="flex flex-col">
                {shortNote !== '—' ? <span>{shortNote}</span> : null}
                {longNote !== '—' ? (
                  <span className="text-muted-foreground text-xs">
                    {longNote}
                  </span>
                ) : null}
              </div>
            </Tooltip>
          );
        },
        size: 260,
      },
    ],
    [isLoading, props.datasourceById, props.groupInfos, props.aorFilterOptions]
  );

  const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
  const resolvedPaperProps =
    typeof basePaperProps === 'function'
      ? basePaperProps
      : () => basePaperProps || {};

  const state = {
    showAlertBanner: false,
    showLoadingOverlay: false,
    showSkeletons: Boolean(props.loading),
    globalFilter: tableStateContext.globalFilter,
    columnVisibility: tableStateContext.columnVisibility,
    columnFilters: tableStateContext.columnFilters,
    density: tableStateContext.density,
    sorting: tableStateContext.sorting,
    columnOrder: tableStateContext.columnOrder,
    columnSizing: tableStateContext.columnSizing,
  };

  const table = useMaterialReactTable({
    columns,
    data: isLoading ? buildZoneLoadingRows() : props.rows,
    ...zoneDefaultMRTOptions,
    enableSorting: true,
    enableColumnActions: true,
    enableGlobalFilter: true,
    enableHiding: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowVirtualization: false,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    columnFilterDisplayMode: 'popover',
    globalFilterFn: 'contains',
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onSortingChange: tableStateContext.onSortingChange,
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
    onDensityChange: tableStateContext.setDensity,
    getColumnCanGlobalFilter: (column) =>
      ZONE_GLOBAL_FILTER_COLUMN_IDS.has(column.id),
    enableRowActions: true,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) =>
      isLoading || !row.original?.group ? null : (
        <MrtRowActions>
          <MrtRowActionButton
            label="Редагувати"
            onClick={() =>
              props.onEdit(
                row.original.zoneId,
                row.original.datasourceId,
                row.original.group
              )
            }
            icon={<EditIcon fontSize="small" />}
          />
          <MrtRowActionButton
            label="Видалити"
            onClick={() =>
              props.onDelete(
                row.original.zoneId,
                row.original.datasourceId,
                row.original.group
              )
            }
            icon={<DeleteIcon fontSize="small" />}
            tone="danger"
          />
        </MrtRowActions>
      ),
    defaultColumn: {
      size: 200,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: mrtRowActionsColumnSize(2),
      },
    },
    muiTablePaperProps: ({ table }) => {
      const baseProps = resolvedPaperProps({ table });
      return {
        ...baseProps,
        sx: {
          ...(baseProps as any)?.sx,
          ...FULL_WIDTH_TABLE_PAPER_SX,
          height: isLoading ? '100%' : 'auto',
          minHeight: isLoading ? '100%' : undefined,
          maxHeight: '100%',
        },
      };
    },
    muiTableContainerProps: {
      sx: {
        ...(CUSTOM_STYLES.muiTableContainerProps as any)?.sx,
        ...getPageScrollTableContainerSx({
          loading: isLoading,
          height: isLoading ? '100%' : 'auto',
          minHeight: isLoading ? '100%' : undefined,
          maxHeight: '100%',
          idleOverflow: 'auto',
        }),
      },
    },
    state,
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return (
    <Box
      sx={{
        display: 'flex',
        width: '100%',
        flex: isLoading ? 1 : undefined,
        minHeight: 0,
        minWidth: 0,
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <TableTabControls
        globalFilter={tableStateContext.globalFilter}
        onGlobalFilterChange={(value) =>
          tableStateContext.onChangeGlobalFilter(value)
        }
        table={table}
        disabled={isLoading}
      />
      <Box
        sx={{
          width: '100%',
          minHeight: 0,
          minWidth: 0,
          overflow: 'hidden',
          maxHeight: '100%',
          flex: isLoading ? 1 : undefined,
          position: 'relative',
          cursor: isLoading ? 'progress' : undefined,
        }}
      >
        {isLoading ? (
          <SectionLoadingOverlay
            open
            ariaLabel="Завантаження таблиці напрямків"
            spinnerMode="center"
            sx={{ zIndex: 12 }}
          />
        ) : null}
        <MaterialReactTable table={table} />
      </Box>
    </Box>
  );
}

function OrphanGroupsSection(props: {
  data: OrphanSignalGroupEntry[];
  loading?: boolean;
  datasourceById: Map<number, Datasource>;
  aorFilterOptions: { text: string; value: string }[];
  onAssign: (group: OrphanSignalGroupEntry) => void;
  onEdit: (group: OrphanSignalGroupEntry) => void;
}) {
  return (
    <TableStateProvider
      tableId="admin-orphan-groups"
      defaultColumnOrder={DEFAULT_ORPHAN_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_ORPHAN_COLUMNS_VISIBILITY}
      defaultSorting={DEFAULT_ACTIVITY_DAY_SORTING}
      defaultEnableColumnOrdering={false}
    >
      <div className="flex min-h-0 w-full min-w-0 max-h-full overflow-hidden">
        <OrphanGroupsTable
          data={props.data}
          loading={props.loading}
          datasourceById={props.datasourceById}
          aorFilterOptions={props.aorFilterOptions}
          onAssign={props.onAssign}
          onEdit={props.onEdit}
        />
      </div>
    </TableStateProvider>
  );
}

function ZoneGroupsSection(props: {
  zoneId: number;
  rows: ZoneGroupRow[];
  loading?: boolean;
  datasourceById: Map<number, Datasource>;
  groupInfos: Map<string, SignalGroupEntry>;
  aorFilterOptions: { text: string; value: string }[];
  onEdit: (
    zoneId: number,
    datasourceId: number,
    group: ZoneDatasourceGroup
  ) => void;
  onDelete: (
    zoneId: number,
    datasourceId: number,
    group: ZoneDatasourceGroup
  ) => void;
}) {
  return (
    <TableStateProvider
      tableId={`admin-zone-${props.zoneId}`}
      defaultColumnOrder={DEFAULT_ZONE_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_ZONE_COLUMNS_VISIBILITY}
      defaultSorting={DEFAULT_ACTIVITY_DAY_SORTING}
      defaultEnableColumnOrdering={false}
    >
      <div className="flex min-h-0 w-full min-w-0 max-h-full overflow-hidden">
        <ZoneGroupsTable
          rows={props.rows}
          loading={props.loading}
          datasourceById={props.datasourceById}
          groupInfos={props.groupInfos}
          aorFilterOptions={props.aorFilterOptions}
          onEdit={props.onEdit}
          onDelete={props.onDelete}
        />
      </div>
    </TableStateProvider>
  );
}

type DirectionsTab =
  | {
      key: 'orphans';
      label: string;
      content: ReactNode;
    }
  | {
      key: `zone-${number}`;
      label: string;
      content: ReactNode;
    };

function AdminDirectionsNeoPageBody() {
  const [status, setStatus] = useState<LoadingStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [datasources, setDatasources] = useState<DatasourceEntry[]>([]);
  const [zones, setZones] = useState<ZoneEntry[]>([]);
  const [zoneDatasourceIds, setZoneDatasourceIds] = useState<
    Map<number, number[]>
  >(new Map());
  const [zoneGroups, setZoneGroups] = useState<
    Map<string, ZoneDatasourceGroup[]>
  >(new Map());
  const [groupInfos, setGroupInfos] = useState<
    Map<string, SignalGroupEntry>
  >(new Map());
  const [orphanGroups, setOrphanGroups] = useState<
    OrphanSignalGroupEntry[]
  >([]);
  const [aors, setAors] = useState<AreaOfResponsibility[]>([]);

  const [editDialog, setEditDialog] = useState<GroupEditState | null>(
    null
  );
  const [orphanEditDialog, setOrphanEditDialog] =
    useState<OrphanEditState | null>(null);
  const [assignDialog, setAssignDialog] =
    useState<OrphanAssignState | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteState | null>(
    null
  );
  const [activeTab, setActiveTab] = useState(0);

  const [logins, setLogins] = useState<string[]>([]);
  const [loginsStatus, setLoginsStatus] = useState<LoadingStatus>('idle');

  const datasourceById = useMemo(
    () => new Map(datasources),
    [datasources]
  );
  const aorOptions = useMemo(() => aors, [aors]);
  const aorFilterOptions = useMemo(
    () => buildAorFilterOptions(aors),
    [aors]
  );
  const directionTabs = useMemo<DirectionsTab[]>(() => {
    if (status === 'loading' || status === 'idle') {
      return [
        {
          key: 'orphans',
          label: 'Орфан групи',
          content: (
            <OrphanGroupsSection
              data={[]}
              loading
              datasourceById={datasourceById}
              aorFilterOptions={aorFilterOptions}
              onAssign={openAssignDialog}
              onEdit={openOrphanEditDialog}
            />
          ),
        },
      ];
    }

    const tabs: DirectionsTab[] = [
      {
        key: 'orphans',
        label: 'Орфан групи',
        content:
          orphanGroups.length === 0 ? (
            <SectionEmptyState message="Орфан групи відсутні" />
          ) : (
            <OrphanGroupsSection
              data={orphanGroups}
              datasourceById={datasourceById}
              aorFilterOptions={aorFilterOptions}
              onAssign={openAssignDialog}
              onEdit={openOrphanEditDialog}
            />
          ),
      },
    ];

    zones.forEach((zoneEntry) => {
      const [zoneId, zone] = zoneEntry;
      const datasourceIds = zoneDatasourceIds.get(zoneId) ?? [];

      const zoneRows = datasourceIds.flatMap((datasourceId) => {
        const key = buildGroupKey(zoneId, datasourceId);
        const groups = zoneGroups.get(key) ?? [];
        return groups.map((group) => ({
          id: `${zoneId}-${datasourceId}-${group.sigintZoneDatasourceId}`,
          zoneId,
          datasourceId,
          group,
        }));
      });

      const filteredRows = zoneRows.sort((a, b) => {
        const nameA = getGroupName(a.group.groupMasterKey, null, groupInfos);
        const nameB = getGroupName(b.group.groupMasterKey, null, groupInfos);
        if (nameA !== nameB) return nameA.localeCompare(nameB, 'uk-UA');
        const datasourceA = getDatasourceLabel(a.datasourceId, datasourceById);
        const datasourceB = getDatasourceLabel(b.datasourceId, datasourceById);
        return datasourceA.localeCompare(datasourceB, 'uk-UA');
      });

      tabs.push({
        key: `zone-${zoneId}`,
        label: `Напрямок: ${zone.name}`,
        content:
          datasourceIds.length === 0 ? (
            <SectionEmptyState message="Немає джерел даних" />
          ) : filteredRows.length === 0 ? (
            <SectionEmptyState message="Немає груп для цього напрямку" />
          ) : (
            <ZoneGroupsSection
              zoneId={zoneId}
              rows={filteredRows}
              datasourceById={datasourceById}
              groupInfos={groupInfos}
              aorFilterOptions={aorFilterOptions}
              onEdit={openEditDialog}
              onDelete={openDeleteDialog}
            />
          ),
      });
    });

    return tabs;
  }, [
    status,
    aorFilterOptions,
    datasourceById,
    groupInfos,
    orphanGroups,
    zoneDatasourceIds,
    zoneGroups,
    zones,
  ]);

  useEffect(() => {
    setActiveTab((current) => Math.min(current, Math.max(directionTabs.length - 1, 0)));
  }, [directionTabs.length]);

  async function ensureLoginsLoaded() {
    if (loginsStatus === 'loading' || loginsStatus === 'success') return;
    setLoginsStatus('loading');
    try {
      const rsp = await listLogins({ sortBy: null, filterByRoles: null });
      setLogins((rsp.users || []).map((login) => login.login));
      setLoginsStatus('success');
    } catch (err) {
      setLoginsStatus('error');
    }
  }

  async function loadData() {
    setStatus('loading');
    setError(null);
    try {
      const [datasourceList, zoneList, orphanList, aorList] = await Promise.all(
        [
          listDatasources(),
          listSigintZones(),
          listOrphanSignalGroups(),
          listAors({ sortBy: null }),
        ]
      );

      setDatasources(datasourceList);
      setZones(zoneList);
      setOrphanGroups(orphanList);
      setAors(aorList);

      const zoneDatasourceEntries = await Promise.all(
        zoneList.map(
          async ([zoneId]) =>
            [zoneId, await listZoneDatasources(zoneId)] as const
        )
      );

      const zoneDatasourceMap = new Map<number, number[]>();
      zoneDatasourceEntries.forEach(([zoneId, datasourceIds]) => {
        zoneDatasourceMap.set(zoneId, datasourceIds || []);
      });
      setZoneDatasourceIds(zoneDatasourceMap);

      const groupEntries = await Promise.all(
        zoneDatasourceEntries.flatMap(([zoneId, datasourceIds]) =>
          datasourceIds.map(async (datasourceId) => ({
            zoneId,
            datasourceId,
            groups: await listZoneDatasourceGroups({ zoneId, datasourceId }),
          }))
        )
      );

      const groupMap = new Map<string, ZoneDatasourceGroup[]>();
      const groupKeys = new Set<string>();
      groupEntries.forEach(({ zoneId, datasourceId, groups }) => {
        groupMap.set(buildGroupKey(zoneId, datasourceId), groups);
        groups.forEach((group) => groupKeys.add(group.groupMasterKey));
      });

      const infoList = await fetchSignalGroupInfoBatch(Array.from(groupKeys));
      const infoMap = new Map(infoList.map((info) => [info.masterKey, info]));

      orphanList.forEach((group) => {
        if (!infoMap.has(group.masterKey)) {
          infoMap.set(group.masterKey, {
            masterKey: group.masterKey,
            name: group.name,
            ignoreOperativny: group.ignoreOperativny,
            groupStats: group.groupStats,
            adminData: group.groupAdminData,
            areasOfResponsibility: group.areasOfResponsibility,
          });
        }
      });

      setZoneGroups(groupMap);
      setGroupInfos(infoMap);

      setStatus('success');
    } catch (err) {
      setStatus('error');
      setError(formatErrorMessage(err));
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  function openEditDialog(
    zoneId: number,
    datasourceId: number,
    group: ZoneDatasourceGroup
  ) {
    const groupName = getGroupName(group.groupMasterKey, null, groupInfos);
    setEditDialog({
      zoneId,
      datasourceId,
      group,
      groupName,
      isSecret: group.isGroupSecret,
      selectedUsers: group.allowedUsers,
      shortNote: group.shortNote ?? '',
      longNote: group.longNote ?? '',
      selectedAorIds: (group.areasOfResponsibility ?? []).map((aor) => aor.id),
      isSaving: false,
      error: null,
    });
    void ensureLoginsLoaded();
  }

  function openOrphanEditDialog(group: OrphanSignalGroupEntry) {
    const groupName =
      group.name && group.name.trim() ? group.name : group.masterKey.slice(-5);
    setOrphanEditDialog({
      group,
      groupName,
      shortNote: group.groupAdminData?.shortNote ?? '',
      longNote: group.groupAdminData?.longNote ?? '',
      selectedAorIds: (group.areasOfResponsibility ?? []).map((aor) => aor.id),
      isSaving: false,
      error: null,
    });
  }

  function openAssignDialog(group: OrphanSignalGroupEntry) {
    const preselectedZones =
      zones.length === 1 ? zones : [];

    setAssignDialog({
      group,
      selectedZones: preselectedZones,
      isSecret: false,
      selectedUsers: [],
      isSaving: false,
      error: null,
    });
    void ensureLoginsLoaded();
  }

  function openDeleteDialog(
    zoneId: number,
    datasourceId: number,
    group: ZoneDatasourceGroup
  ) {
    const groupName = getGroupName(group.groupMasterKey, null, groupInfos);
    setDeleteDialog({
      zoneId,
      datasourceId,
      group,
      groupName,
      isDeleting: false,
      error: null,
    });
  }

  async function handleSaveGroupEdit() {
    if (!editDialog) return;
    setEditDialog({ ...editDialog, isSaving: true, error: null });

    const selectedUsers = editDialog.isSecret ? editDialog.selectedUsers : [];
    const req: ZoneDatasourceGroupUpdateReq = {
      id: editDialog.group.sigintZoneDatasourceId,
      isSecret: editDialog.isSecret,
      userLogins: selectedUsers,
      shortNote: editDialog.shortNote.trim()
        ? editDialog.shortNote.trim()
        : null,
      longNote: editDialog.longNote.trim() ? editDialog.longNote.trim() : null,
      areaOfResponsibilityId: null,
      areaOfResponsibilityIds:
        editDialog.selectedAorIds.length > 0 ? editDialog.selectedAorIds : null,
    };

    try {
      const updatedGroup = await updateZoneDatasourceGroup(req);
      setZoneGroups((prev) => {
        const next = new Map(prev);
        const key = buildGroupKey(editDialog.zoneId, editDialog.datasourceId);
        const groups = next.get(key) ?? [];
        next.set(
          key,
          groups.map((item) =>
            item.sigintZoneDatasourceId === updatedGroup.sigintZoneDatasourceId
              ? updatedGroup
              : item
          )
        );
        return next;
      });
      setEditDialog(null);
    } catch (err) {
      setEditDialog({
        ...editDialog,
        isSaving: false,
        error: 'Не вдалося зберегти групу',
      });
    }
  }

  async function handleSaveOrphanEdit() {
    if (!orphanEditDialog) return;
    setOrphanEditDialog({ ...orphanEditDialog, isSaving: true, error: null });

    try {
      const updated = await editGroup({
        masterKey: orphanEditDialog.group.masterKey,
        shortNote: orphanEditDialog.shortNote.trim()
          ? orphanEditDialog.shortNote.trim()
          : null,
        longNote: orphanEditDialog.longNote.trim()
          ? orphanEditDialog.longNote.trim()
          : null,
        areaOfResponsibilityId: null,
        areaOfResponsibilityIds:
          orphanEditDialog.selectedAorIds.length > 0
            ? orphanEditDialog.selectedAorIds
            : null,
      });

      setOrphanGroups((prev) =>
        prev.map((group) => {
          if (group.masterKey !== updated.masterKey) return group;
          return {
            ...group,
            groupAdminData:
              updated.shortNote || updated.longNote
                ? {
                    shortNote: updated.shortNote ?? null,
                    longNote: updated.longNote ?? null,
                  }
                : null,
            areasOfResponsibility: updated.areasOfResponsibility ?? null,
          };
        })
      );

      setOrphanEditDialog(null);
    } catch (err) {
      setOrphanEditDialog({
        ...orphanEditDialog,
        isSaving: false,
        error: 'Не вдалося зберегти зміни',
      });
    }
  }

  async function handleAssignOrphanGroup() {
    if (!assignDialog) return;
    const hasAor =
      assignDialog.group.areasOfResponsibility &&
      assignDialog.group.areasOfResponsibility.length > 0;
    if (!hasAor) {
      setAssignDialog({
        ...assignDialog,
        error: 'Спочатку призначте смугу відповідальності для групи',
      });
      return;
    }
    if (!assignDialog.group.datasourceId) {
      setAssignDialog({
        ...assignDialog,
        error: 'У групи немає привʼязаного датасорса',
      });
      return;
    }

    setAssignDialog({ ...assignDialog, isSaving: true, error: null });

    const datasourceId = assignDialog.group.datasourceId;
    const selectedUsers = assignDialog.isSecret
      ? assignDialog.selectedUsers
      : [];
    const requests: ZoneDatasourceGroupAddReq[] =
      assignDialog.selectedZones.map(([zoneId]) => ({
        zoneId,
        datasourceId,
        masterKey: assignDialog.group.masterKey,
        isSecret: assignDialog.isSecret,
        userLogins: selectedUsers,
        shortNote: assignDialog.group.groupAdminData?.shortNote ?? null,
        longNote: assignDialog.group.groupAdminData?.longNote ?? null,
      }));

    try {
      const responses = await Promise.all(
        requests.map((req) => addZoneDatasourceGroup(req))
      );

      setZoneGroups((prev) => {
        const next = new Map(prev);
        responses.forEach((response) => {
          const key = buildGroupKey(response.zoneId, response.datasourceId);
          const groups = next.get(key) ?? [];
          next.set(key, [...groups, response.zoneDatasourceGroup]);
        });
        return next;
      });

      setZoneDatasourceIds((prev) => {
        const next = new Map(prev);
        responses.forEach((response) => {
          const current = next.get(response.zoneId) ?? [];
          if (!current.includes(response.datasourceId)) {
            next.set(response.zoneId, [...current, response.datasourceId]);
          }
        });
        return next;
      });

      setGroupInfos((prev) => {
        const next = new Map(prev);
        responses.forEach((response) => {
          if (!response.groupName) return;
          if (!next.has(response.groupMasterKey)) {
            next.set(response.groupMasterKey, {
              masterKey: response.groupMasterKey,
              name: response.groupName,
              ignoreOperativny: false,
              groupStats: assignDialog.group.groupStats,
              adminData: assignDialog.group.groupAdminData,
              areasOfResponsibility: assignDialog.group.areasOfResponsibility,
            });
          }
        });
        return next;
      });

      setOrphanGroups((prev) =>
        prev.filter((group) => group.masterKey !== assignDialog.group.masterKey)
      );
      setAssignDialog(null);
    } catch (err) {
      setAssignDialog({
        ...assignDialog,
        isSaving: false,
        error: 'Не вдалося призначити групу',
      });
    }
  }

  async function handleDeleteGroup() {
    if (!deleteDialog) return;
    setDeleteDialog({ ...deleteDialog, isDeleting: true, error: null });
    try {
      await deleteZoneDatasourceGroup(
        deleteDialog.group.sigintZoneDatasourceId
      );
      setZoneGroups((prev) => {
        const next = new Map(prev);
        const key = buildGroupKey(
          deleteDialog.zoneId,
          deleteDialog.datasourceId
        );
        const groups = next.get(key) ?? [];
        next.set(
          key,
          groups.filter(
            (group) =>
              group.sigintZoneDatasourceId !==
              deleteDialog.group.sigintZoneDatasourceId
          )
        );
        return next;
      });
      setDeleteDialog(null);
    } catch (err) {
      setDeleteDialog({
        ...deleteDialog,
        isDeleting: false,
        error: 'Не вдалося видалити групу',
      });
    }
  }

  const renderContent = () => {
    if (status === 'error') {
      return <PageErrorState message={error || 'Помилка завантаження'} />;
    }

    return (
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <Tabs
          value={activeTab}
          onChange={(_, value: number) => setActiveTab(value)}
          variant="scrollable"
          allowScrollButtonsMobile
          sx={{
            minHeight: 48,
            borderBottom: '1px solid',
            borderColor: 'divider',
            flexShrink: 0,
          }}
        >
          {directionTabs.map((tab) => (
            <Tab
              key={tab.key}
              label={tab.label}
              sx={{
                alignItems: 'flex-start',
                textAlign: 'left',
                minHeight: 48,
              }}
            />
          ))}
        </Tabs>

        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            minWidth: 0,
            display: 'flex',
            overflow: 'hidden',
            pt: 1.5,
          }}
        >
          {directionTabs.map((tab, index) => (
            <Box
              key={tab.key}
              role="tabpanel"
              hidden={activeTab !== index}
              sx={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                display: activeTab === index ? 'flex' : 'none',
                overflow: 'hidden',
              }}
            >
              <Box
                sx={{
                  flex: 1,
                  minHeight: 0,
                  minWidth: 0,
                  display: 'flex',
                  overflow: 'hidden',
                }}
              >
                {tab.content}
              </Box>
            </Box>
          ))}
        </Box>
      </Box>
    );
  };

  return (
    <div className="flex h-full w-full min-w-0 flex-col gap-4 overflow-hidden">
      {error ? (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      ) : null}

      <TablePageToolbar
        title="Напрямки"
        withGlobalTextFilter={false}
        internalActionsHidden
        internalActionsDisabled={status === 'loading'}
      />

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {renderContent()}
      </div>

      <Dialog
        open={Boolean(editDialog)}
        onClose={() => setEditDialog(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Редагувати групу</DialogTitle>
        <DialogContent className="space-y-4">
          {editDialog?.error ? (
            <Alert severity="error">{editDialog.error}</Alert>
          ) : null}
          <div className="text-sm text-muted-foreground">
            Група: {editDialog?.groupName}
          </div>
          <FormControlLabel
            control={
              <Switch
                checked={editDialog?.isSecret ?? false}
                onChange={(event) =>
                  editDialog &&
                  setEditDialog({
                    ...editDialog,
                    isSecret: event.target.checked,
                  })
                }
              />
            }
            label="Прихована група"
          />
          {editDialog?.isSecret ? (
            <Autocomplete
              multiple
              options={logins}
              value={editDialog?.selectedUsers ?? []}
              onChange={(_, value) =>
                editDialog &&
                setEditDialog({ ...editDialog, selectedUsers: value })
              }
              renderInput={(params) => (
                <TextField {...params} label="Користувачі" />
              )}
            />
          ) : null}
          <Autocomplete
            multiple
            options={aorOptions}
            getOptionLabel={(option) => option.name}
            value={
              (editDialog?.selectedAorIds ?? [])
                .map((id) => aorOptions.find((aor) => aor.id === id))
                .filter(Boolean) as AreaOfResponsibility[]
            }
            onChange={(_, value) =>
              editDialog &&
              setEditDialog({
                ...editDialog,
                selectedAorIds: value.map((aor) => aor.id),
              })
            }
            renderInput={(params) => (
              <TextField {...params} label="Смуги відповідальності" />
            )}
            isOptionEqualToValue={(option, value) => option.id === value.id}
          />
          <TextField
            label="Коротка нотатка"
            multiline
            minRows={2}
            value={editDialog?.shortNote ?? ''}
            onChange={(event) =>
              editDialog &&
              setEditDialog({ ...editDialog, shortNote: event.target.value })
            }
          />
          <TextField
            label="Довга нотатка"
            multiline
            minRows={3}
            value={editDialog?.longNote ?? ''}
            onChange={(event) =>
              editDialog &&
              setEditDialog({ ...editDialog, longNote: event.target.value })
            }
          />
        </DialogContent>
        <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
          <Button
            variant="outlined"
            onClick={() => setEditDialog(null)}
            disabled={editDialog?.isSaving}
          >
            Скасувати
          </Button>
          <Button
            variant="contained"
            onClick={handleSaveGroupEdit}
            disabled={editDialog?.isSaving}
          >
            Зберегти
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(orphanEditDialog)}
        onClose={() => setOrphanEditDialog(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Редагувати орфан групу</DialogTitle>
        <DialogContent className="space-y-4">
          {orphanEditDialog?.error ? (
            <Alert severity="error">{orphanEditDialog.error}</Alert>
          ) : null}
          <div className="text-sm text-muted-foreground">
            Група: {orphanEditDialog?.groupName}
          </div>
          <Autocomplete
            multiple
            options={aorOptions}
            getOptionLabel={(option) => option.name}
            value={
              (orphanEditDialog?.selectedAorIds ?? [])
                .map((id) => aorOptions.find((aor) => aor.id === id))
                .filter(Boolean) as AreaOfResponsibility[]
            }
            onChange={(_, value) =>
              orphanEditDialog &&
              setOrphanEditDialog({
                ...orphanEditDialog,
                selectedAorIds: value.map((aor) => aor.id),
              })
            }
            renderInput={(params) => (
              <TextField {...params} label="Смуги відповідальності" />
            )}
            isOptionEqualToValue={(option, value) => option.id === value.id}
          />
          <TextField
            label="Коротка нотатка"
            multiline
            minRows={2}
            value={orphanEditDialog?.shortNote ?? ''}
            onChange={(event) =>
              orphanEditDialog &&
              setOrphanEditDialog({
                ...orphanEditDialog,
                shortNote: event.target.value,
              })
            }
          />
          <TextField
            label="Довга нотатка"
            multiline
            minRows={3}
            value={orphanEditDialog?.longNote ?? ''}
            onChange={(event) =>
              orphanEditDialog &&
              setOrphanEditDialog({
                ...orphanEditDialog,
                longNote: event.target.value,
              })
            }
          />
        </DialogContent>
        <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
          <Button
            variant="outlined"
            onClick={() => setOrphanEditDialog(null)}
            disabled={orphanEditDialog?.isSaving}
          >
            Скасувати
          </Button>
          <Button
            variant="contained"
            onClick={handleSaveOrphanEdit}
            disabled={orphanEditDialog?.isSaving}
          >
            Зберегти
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(assignDialog)}
        onClose={() => setAssignDialog(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Додати орфан групу до напрямків</DialogTitle>
        <DialogContent className="space-y-4">
          {assignDialog?.error ? (
            <Alert severity="error">{assignDialog.error}</Alert>
          ) : null}
          <div className="text-sm text-muted-foreground">
            Група:{' '}
            {assignDialog?.group.name ||
              assignDialog?.group.masterKey.slice(-5)}
          </div>
          <Autocomplete
            multiple
            options={zones}
            getOptionLabel={(option) => option[1].name}
            value={assignDialog?.selectedZones ?? []}
            onChange={(_, value) =>
              assignDialog &&
              setAssignDialog({ ...assignDialog, selectedZones: value })
            }
            renderInput={(params) => <TextField {...params} label="Напрямки" />}
            isOptionEqualToValue={(option, value) => option[0] === value[0]}
          />
          <FormControlLabel
            control={
              <Switch
                checked={assignDialog?.isSecret ?? false}
                onChange={(event) =>
                  assignDialog &&
                  setAssignDialog({
                    ...assignDialog,
                    isSecret: event.target.checked,
                  })
                }
              />
            }
            label="Прихована група"
          />
          {assignDialog?.isSecret ? (
            <Autocomplete
              multiple
              options={logins}
              value={assignDialog?.selectedUsers ?? []}
              onChange={(_, value) =>
                assignDialog &&
                setAssignDialog({ ...assignDialog, selectedUsers: value })
              }
              renderInput={(params) => (
                <TextField {...params} label="Користувачі" />
              )}
            />
          ) : null}
        </DialogContent>
        <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
          <Button
            variant="outlined"
            onClick={() => setAssignDialog(null)}
            disabled={assignDialog?.isSaving}
          >
            Скасувати
          </Button>
          <Button
            variant="contained"
            onClick={handleAssignOrphanGroup}
            disabled={assignDialog?.isSaving}
          >
            Додати
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDangerDialog
        open={Boolean(deleteDialog)}
        onClose={() => setDeleteDialog(null)}
        onConfirm={handleDeleteGroup}
        submitting={Boolean(deleteDialog?.isDeleting)}
        disabled={!deleteDialog}
      >
          {deleteDialog?.error ? (
            <Alert severity="error">{deleteDialog.error}</Alert>
          ) : null}
          <Typography variant="body2" className="text-muted-foreground">
            Ви впевнені, що хочете видалити групу {deleteDialog?.groupName}?
          </Typography>
      </ConfirmDangerDialog>
    </div>
  );
}

export function AdminDirectionsNeoPage() {
  return <AdminDirectionsNeoPageBody />;
}
