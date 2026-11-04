import {
  AUTHOR_COLUMN_META,
  mrtAuthorCell,
} from '../../../components/mui-customized/table/mrt-author-cell';
import { Link, Skeleton } from '@mui/material';
import type { MRT_ColumnOrderState, MRT_TableInstance } from 'material-react-table';
import { MaterialReactTable } from 'material-react-table';
import { useEffect, useMemo, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import { mrtRowActionsColumnSize } from '../../../components/MrtRowActionButton';
import { DeviceRating } from './DeviceRating';
import { DeviceStatusIcon } from './DeviceStatusIcon';
import { DeviceTagsCell } from './DeviceTagsCell';
import { SectionLoadingOverlay } from '../../../components/SectionLoadingOverlay';
import { TableEmptyState } from '../../../components/TableEmptyState';
import { handleNavigateWithinSpaClick } from '../../../utils/browser';
import {
  CUSTOM_STYLES,
  FULL_HEIGHT_LOADING_ROW_COUNT,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../../components/mui-customized/table/custom-styles';
import {
  getDefaultMRTOptions,
  mrtCustomCell,
  mrtTextCell,
  type AppMrtColumnDef,
  useAppMaterialReactTable,
  renderColumnActionsMenuItems,
} from '../../../components/mui-customized/table/get-default-table-options';
import { MrtOverflowText } from '../../../components/mui-customized/table/mrt-overflow';
import type { useTableStateContext } from '../../../components/mui-customized/table/table-state-provider';
import { DeviceRecentActivityCell } from './DeviceRecentActivityCell';
import { DeviceRowActions } from './DeviceRowActions';
import { DeviceSizeLabel } from './DeviceSizeLabel';
import { DeviceMobileList } from './DeviceMobileList';
import { useDeviceMobileLayout } from '../use-device-mobile-layout';
import {
  customFieldColumnId,
  mergeCustomFieldColumnOrder,
  DEVICES_LOADING_PLACEHOLDER_COUNT,
  DEVICES_LOADING_ROW_ID_PREFIX,
  type DeviceRowView,
} from '../helpers';
import { useDeviceAutoLoad } from '../use-device-auto-load';

const defaultMrtOptions = getDefaultMRTOptions<DeviceRowView>();
const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
const resolvedPaperProps =
  typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

type Props = {
  rows: DeviceRowView[];
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  startOffset: number;
  scrollResetKey: string;
  autoLoadBlocked: boolean;
  canEdit: boolean;
  canRate: boolean;
  onRate: (deviceId: string, rating: number) => void;
  mutatingDeviceId: string | null;
  hasFilters: boolean;
  tableStateContext: ReturnType<typeof useTableStateContext>;
  onEdit: (deviceId: string) => void;
  onLoadMore: () => Promise<void>;
  onClearFilters: () => void;
  onTableInitialized: (table: MRT_TableInstance<DeviceRowView>) => void;
  columnOrder: MRT_ColumnOrderState;
  customFieldKeys: string[];
};

const EMPTY_CELL_VALUE = '—';

function buildCustomFieldColumns(customFieldKeys: string[]): AppMrtColumnDef<DeviceRowView>[] {
  return customFieldKeys.map((key) => ({
    id: customFieldColumnId(key),
    accessorFn: (row) => row.customFields[key] ?? '',
    header: key,
    size: 180,
    enableSorting: false,
    meta: { overflowMode: 'text' },
    Cell: mrtTextCell<DeviceRowView>({
      fullValue: ({ cell }) => (cell.getValue() as string) || EMPTY_CELL_VALUE,
      displayValue: ({ cell }) => (cell.getValue() as string) || EMPTY_CELL_VALUE,
    }),
  }));
}

function useDevicesTableColumns({
  canRate,
  mutatingDeviceId,
  onRate,
  customFieldKeys,
}: Pick<
  Props,
  'canRate' | 'mutatingDeviceId' | 'onRate' | 'customFieldKeys'
>): AppMrtColumnDef<DeviceRowView>[] {
  return useMemo(
    () => [
      {
        id: 'name',
        accessorFn: (row) => row.name,
        header: 'Назва',
        size: 260,
        meta: { overflowMode: 'custom', overflowOwner: 'shared-text' },
        Cell: mrtCustomCell<DeviceRowView>(({ row }) => {
          const href = `/devices/${row.original.id}`;
          return (
            <div className="flex min-w-0 items-center gap-echo-sm">
              <DeviceStatusIcon archived={row.original.archived} />
              <MrtOverflowText
                displayValue={row.original.name ?? 'Без назви'}
                fullValue={row.original.name ?? 'Без назви'}
                interactive
                component="a"
                componentProps={{
                  href,
                  onClick: (event: ReactMouseEvent<HTMLElement>) =>
                    handleNavigateWithinSpaClick(event, href),
                }}
                sx={{ color: 'primary.main', fontWeight: 600, textDecoration: 'none' }}
              />
            </div>
          );
        }),
      },
      {
        id: 'description',
        accessorFn: (row) => row.description ?? '',
        header: 'Опис',
        size: 260,
        enableSorting: false,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell<DeviceRowView>({
          fullValue: ({ cell }) => (cell.getValue() as string) || EMPTY_CELL_VALUE,
          displayValue: ({ cell }) => (cell.getValue() as string) || EMPTY_CELL_VALUE,
        }),
      },
      {
        accessorKey: 'rating',
        header: 'Рейтинг',
        size: 160,
        meta: { overflowMode: 'none' },
        Cell: ({ row }) => (
          <DeviceRating
            row={row.original}
            canRate={canRate}
            disabled={mutatingDeviceId !== null}
            onRate={onRate}
          />
        ),
      },
      {
        id: 'aors',
        accessorKey: 'aorLabel',
        header: 'Смуги',
        size: 160,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell<DeviceRowView>({
          fullValue: ({ cell }) => cell.getValue() as string,
          displayValue: ({ cell }) => cell.getValue() as string,
        }),
      },
      {
        id: 'unit',
        accessorKey: 'unitLabel',
        header: 'Підрозділ',
        size: 220,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell<DeviceRowView>({
          fullValue: ({ cell }) => cell.getValue() as string,
          displayValue: ({ cell }) => cell.getValue() as string,
        }),
      },
      {
        id: 'createdBy',
        accessorKey: 'createdBy',
        header: 'Створив',
        meta: { ...AUTHOR_COLUMN_META, interactive: false },
        Cell: mrtAuthorCell((row) => row.createdBy, false),
        size: 170,
      },
      {
        id: 'createdAt',
        accessorKey: 'createdAt',
        header: 'Створено',
        size: 170,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell<DeviceRowView>({
          displayValue: ({ row }) => row.original.createdAtLabel,
          fullValue: ({ row }) => row.original.createdAtLabel,
        }),
      },
      {
        id: 'activity',
        accessorFn: (row) => row.activity,
        header: 'Активність',
        size: 180,
        meta: { overflowMode: 'none' },
        Cell: ({ row }) => (
          <DeviceRecentActivityCell
            activity={row.original.activity}
            splitFilesAudio={row.original.activitySplitFilesAudio}
          />
        ),
      },
      {
        id: 'size',
        accessorKey: 'sizeLabel',
        header: 'Розмір',
        size: 160,
        meta: { overflowMode: 'none' },
        Cell: ({ row }) => <DeviceSizeLabel row={row.original} />,
      },
      {
        accessorKey: 'tags',
        header: 'Теги',
        size: 160,
        enableSorting: false,
        meta: { overflowMode: 'none' },
        Cell: ({ row }) => <DeviceTagsCell tags={row.original.tags} />,
      },
      ...buildCustomFieldColumns(customFieldKeys),
    ],
    [canRate, mutatingDeviceId, onRate, customFieldKeys],
  );
}

export function DevicesTable({
  rows,
  loading,
  refreshing,
  loadingMore,
  hasMore,
  startOffset,
  scrollResetKey,
  autoLoadBlocked,
  canEdit,
  canRate,
  onRate,
  mutatingDeviceId,
  hasFilters,
  tableStateContext,
  onEdit,
  onLoadMore,
  onClearFilters,
  onTableInitialized,
  columnOrder,
  customFieldKeys,
}: Props) {
  const mobile = useDeviceMobileLayout();
  const columns = useDevicesTableColumns({ canRate, mutatingDeviceId, onRate, customFieldKeys });
  const baseColumnOrder = tableStateContext.columnOrder ?? columnOrder;
  const customFieldColumnIds = useMemo(
    () => customFieldKeys.map(customFieldColumnId),
    [customFieldKeys],
  );
  const effectiveColumnOrder = useMemo(
    () => mergeCustomFieldColumnOrder(baseColumnOrder, customFieldColumnIds),
    [baseColumnOrder, customFieldColumnIds],
  );
  // Custom field columns are hidden unless the user enabled them (persisted by TableStateProvider).
  const effectiveColumnVisibility = useMemo(
    () => ({
      ...Object.fromEntries(customFieldColumnIds.map((id) => [id, false])),
      ...(tableStateContext.columnVisibility ?? {}),
    }),
    [customFieldColumnIds, tableStateContext.columnVisibility],
  );
  const tableRows = useMemo(() => {
    const template = rows.at(-1);
    if (!loadingMore || !template) return rows;
    return [
      ...rows,
      ...Array.from({ length: DEVICES_LOADING_PLACEHOLDER_COUNT }, (_, index) => ({
        ...template,
        id: `${DEVICES_LOADING_ROW_ID_PREFIX}${index}`,
      })),
    ];
  }, [loadingMore, rows]);
  const isInitialLoading = loading && rows.length === 0;
  const isEmptyResult = !isInitialLoading && rows.length === 0;
  const showTableOverlay = !isInitialLoading && (refreshing || mutatingDeviceId !== null);

  const scroll = useDeviceAutoLoad({
    hasMore,
    blocked: autoLoadBlocked || loading || refreshing || loadingMore || mutatingDeviceId !== null,
    resetKey: scrollResetKey,
    onLoadMore,
  });

  const table = useAppMaterialReactTable({
    data: tableRows,
    columns,
    enableRowVirtualization: true,
    enableColumnActions: true,
    enableGlobalFilter: true,
    enableColumnFilters: false,
    enableColumnFilterModes: false,
    enableFacetedValues: false,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    enableSorting: true,
    manualFiltering: true,
    manualSorting: true,
    enableHiding: true,
    enableRowActions: canEdit,
    positionActionsColumn: 'first',
    enableRowNumbers: true,
    initialState: {
      columnOrder,
      pagination: {
        pageIndex: 0,
        pageSize: FULL_HEIGHT_LOADING_ROW_COUNT,
      },
    },
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
    onSortingChange: tableStateContext.onSortingChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    renderRowActions: ({ row }) => (
      <DeviceRowActions
        row={row.original}
        canEdit={canEdit}
        disabled={mutatingDeviceId !== null}
        onEdit={onEdit}
      />
    ),
    defaultColumn: {
      size: 180,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-numbers': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-numbers'],
        enableResizing: false,
        Cell: ({ row }) => <span>{startOffset + row.index + 1}</span>,
      },
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: mrtRowActionsColumnSize(1),
        enableResizing: false,
      },
    },
    renderEmptyRowsFallback: () => (
      <TableEmptyState
        message={hasFilters ? 'Пристрої не знайдено' : 'Пристрої ще не створені'}
        actionLabel={hasFilters ? 'Очистити фільтри' : undefined}
        onAction={hasFilters ? onClearFilters : undefined}
      />
    ),
    muiTablePaperProps: ({ table }) => {
      const paperProps = resolvedPaperProps({ table });
      return {
        ...paperProps,
        sx: {
          ...(paperProps as { sx?: object }).sx,
          ...FULL_WIDTH_TABLE_PAPER_SX,
          width: '100%',
          maxWidth: '100%',
          height: '100%',
          minHeight: isInitialLoading || isEmptyResult ? '100%' : 0,
          minWidth: 0,
          overflow: table.getState().isFullScreen
            ? 'auto'
            : showTableOverlay || isEmptyResult
              ? 'hidden'
              : 'auto',
          border: 0,
          borderRadius: 0,
          boxShadow: 'none',
        },
        style: {
          ...((paperProps as { style?: object }).style ?? {}),
          padding: 0,
        },
      };
    },
    muiTableContainerProps: {
      ref: scroll.containerRef,
      onScroll: scroll.onScroll,
      id: 'devices-table-scroll',
      sx: getPageScrollTableContainerSx({
        loading: showTableOverlay,
        height: '100%',
        minHeight: isInitialLoading || isEmptyResult ? '100%' : 0,
        maxHeight: 'none',
        idleOverflowX: 'auto',
        idleOverflowY: isEmptyResult ? 'hidden' : 'auto',
        idleOverflow: isEmptyResult ? 'hidden' : 'auto',
      }),
    },
    muiTableHeadCellProps: {
      sx: {
        ...CUSTOM_STYLES.muiTableHeadCellProps.sx,
        '& .Mui-TableHeadCell-ResizeHandle-Wrapper': {
          mr: '-8px',
        },
      },
    },
    muiTableBodyRowProps: ({ row }) =>
      row.id.startsWith(DEVICES_LOADING_ROW_ID_PREFIX)
        ? { id: row.original.id, 'aria-hidden': true, className: 'pointer-events-none' }
        : {},
    muiTableBodyCellProps: ({ row }) => ({
      sx: {
        ...CUSTOM_STYLES.muiTableBodyCellProps.sx,
        verticalAlign: 'top',
      },
      ...(row.id.startsWith(DEVICES_LOADING_ROW_ID_PREFIX)
        ? {
            tabIndex: -1,
            children: <Skeleton animation="wave" variant="rounded" height={24} width="80%" />,
          }
        : {}),
    }),
    muiTableBodyProps: {
      sx: {
        ...CUSTOM_STYLES.muiTableBodyProps.sx,
        minHeight: isInitialLoading || isEmptyResult ? '100%' : 0,
      },
    },
    muiTableProps: {
      'aria-label': 'Пристрої',
    },
    state: {
      isLoading: loading,
      showLoadingOverlay: false,
      showSkeletons: isInitialLoading,
      showProgressBars: false,
      globalFilter: tableStateContext.globalFilter,
      sorting: tableStateContext.sorting,
      columnOrder: effectiveColumnOrder,
      columnSizing: tableStateContext.columnSizing ?? {},
      columnVisibility: effectiveColumnVisibility,
    },
  });

  const onTableInitializedRef = useRef(onTableInitialized);

  useEffect(() => {
    onTableInitializedRef.current = onTableInitialized;
  }, [onTableInitialized]);

  useEffect(() => {
    onTableInitializedRef.current(table);
  }, [table]);

  if (mobile)
    return (
      <DeviceMobileList
        table={table}
        rows={rows}
        loading={loading}
        refreshing={refreshing}
        loadingMore={loadingMore}
        hasMore={hasMore}
        startOffset={startOffset}
        scrollResetKey={scrollResetKey}
        autoLoadBlocked={autoLoadBlocked}
        canEdit={canEdit}
        canRate={canRate}
        onRate={onRate}
        mutatingDeviceId={mutatingDeviceId}
        hasFilters={hasFilters}
        onEdit={onEdit}
        onLoadMore={onLoadMore}
        onClearFilters={onClearFilters}
      />
    );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden border border-echo-border bg-echo-surface">
      <SectionLoadingOverlay open={showTableOverlay} ariaLabel="Оновлення пристроїв" showSpinner />
      <MaterialReactTable table={table} />
      {loadingMore ? (
        <span role="status" className="sr-only">
          Завантаження наступних пристроїв
        </span>
      ) : null}
    </div>
  );
}
