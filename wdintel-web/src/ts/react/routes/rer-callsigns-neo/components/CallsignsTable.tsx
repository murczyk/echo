import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import { Box, Button, CircularProgress, Stack, Tooltip, Typography } from '@mui/material';
import {
  MRT_ColumnDef,
  MRT_ColumnFiltersState,
  MRT_SortingState,
  MaterialReactTable,
  useMaterialReactTable,
} from 'material-react-table';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import {
  MrtRowActionButton,
  MrtRowActions,
  mrtRowActionsColumnSize,
} from '../../../components/MrtRowActionButton';
import type { DevelopingFilter } from '../../../../../Bindings';
import { ELLIPSIS } from '../../../utils/misc';
import { formatMrtCellTextValue } from '../../../components/formatMrtCellTextValue';
import { PowerChip } from '../../../components/PowerChip';
import { SectionLoadingOverlay } from '../../../components/SectionLoadingOverlay';
import { renderMrtCellTextValue } from '../../../components/mui-customized/table/mrt-cell-text';
import {
  CUSTOM_STYLES,
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../../components/mui-customized/table/custom-styles';
import {
  buildExplicitSingleSelectColumnFilter,
  buildDefaultColumnOrder,
  getFilterModeHelperText,
  getDefaultMRTOptions,
  getSharedFilterTextFieldProps,
  renderColumnActionsMenuItems,
  renderDefaultMrtEmptyRowsFallback,
  withExplicitSelectAllOption,
} from '../../../components/mui-customized/table/get-default-table-options';
import { useTableStateContext } from '../../../components/mui-customized/table/table-state-provider';
import type { CallsignRowView, CallsignsSortState, OnSort, SortColumn } from '../types';
import { formatDateTime } from '../helpers';

const defaultMRTOptions = getDefaultMRTOptions<CallsignRowView>();
const STATUS_FILTER_OPTIONS = withExplicitSelectAllOption([
  { text: 'Відомий', value: 'Відомий' },
  { text: 'В дорозвідці', value: 'В дорозвідці' },
]);

export const DEFAULT_CALLSIGNS_TABLE_COLUMN_VISIBILITY = {
  callsign: true,
  position: true,
  fullName: true,
  comment: true,
  unit: true,
  sourceName: true,
  radioFreq: true,
  developing: true,
  createdAt: true,
};

export const DEFAULT_CALLSIGNS_TABLE_COLUMN_ORDER = buildDefaultColumnOrder({
  dataColumnIds: [
    'callsign',
    'position',
    'fullName',
    'comment',
    'unit',
    'sourceName',
    'radioFreq',
    'developing',
    'createdAt',
  ],
  withRowSelection: true,
  withRowNumbers: true,
  withRowActions: true,
});

type Props = {
  canEdit: boolean;
  rows: CallsignRowView[];
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  showLoadMore: boolean;
  hasActiveFilters: boolean;
  textFilters: {
    filterCallsign: string;
    filterPosition: string;
    filterFullName: string;
    filterComment: string;
    filterUnit: string;
  };
  inFlightDeleteId: number | null;
  bulkDeleteInFlight: boolean;
  selectedCallsignIds: number[];
  sort: CallsignsSortState;
  statusFilter: DevelopingFilter;
  onSort: OnSort;
  onStatusFilterChange: (value: DevelopingFilter) => void;
  onTextColumnFiltersChange: (next: {
    filterCallsign: string;
    filterPosition: string;
    filterFullName: string;
    filterComment: string;
    filterUnit: string;
  }) => void;
  onClearFilters: () => void;
  onSetSelectedCallsignIds: (callsignIds: number[]) => void;
  onLoadMore: () => void;
  onEdit: (row: CallsignRowView) => void;
  onDelete: (row: CallsignRowView) => void;
};

type Updater<T> = T | ((prev: T) => T);

export function getCallsignsTableContainerOverflowY({
  hasVerticalOverflow,
  showTableOverlay,
}: {
  hasVerticalOverflow: boolean;
  showTableOverlay: boolean;
}) {
  if (showTableOverlay) return 'hidden';
  return hasVerticalOverflow ? 'auto' : 'hidden';
}

function CommentCell({ comment }: { comment: string }) {
  const text = formatMrtCellTextValue(comment);
  if (text.length <= 80) return renderMrtCellTextValue(text);

  return (
    <Tooltip title={text} placement="top-start">
      <Typography variant="body2" sx={{ maxWidth: 280 }} noWrap>
        {text}
      </Typography>
    </Tooltip>
  );
}

function toMrtSorting(sort: CallsignsSortState): MRT_SortingState {
  return [{ id: sort.column, desc: sort.direction === 'desc' }];
}

function toStatusFilterValue(filter: DevelopingFilter): string[] {
  if (filter === 'OnlyDeveloping') return ['В дорозвідці'];
  if (filter === 'All') return ['Усі'];
  return ['Відомий'];
}

function fromStatusFilterValue(value: unknown): DevelopingFilter {
  if (Array.isArray(value)) {
    return fromStatusFilterValue(value[0]);
  }
  if (value === 'В дорозвідці') return 'OnlyDeveloping';
  if (value === 'Усі') return 'All';
  return 'OnlyNonDeveloping';
}

function getStringColumnFilterValue(filters: MRT_ColumnFiltersState, id: string) {
  const value = filters.find((item) => item.id === id)?.value;
  return typeof value === 'string' ? value : '';
}

function resolveUpdater<T>(value: Updater<T>, current: T): T {
  return typeof value === 'function' ? (value as (prev: T) => T)(current) : value;
}

function CallsignsTableComponent({
  canEdit,
  rows,
  loading,
  refreshing,
  loadingMore,
  showLoadMore,
  hasActiveFilters,
  textFilters,
  inFlightDeleteId,
  bulkDeleteInFlight,
  selectedCallsignIds,
  sort,
  statusFilter,
  onSort,
  onStatusFilterChange,
  onTextColumnFiltersChange,
  onClearFilters,
  onSetSelectedCallsignIds,
  onLoadMore,
  onEdit,
  onDelete,
}: Props) {
  const tableStateContext = useTableStateContext();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const tableContainerRef = useRef<HTMLDivElement | null>(null);
  const [overlayViewport, setOverlayViewport] = useState({
    top: 0,
    left: 0,
    width: 0,
    height: 0,
  });
  const [tableContainerHasVerticalOverflow, setTableContainerHasVerticalOverflow] = useState(false);

  const columns = useMemo<MRT_ColumnDef<CallsignRowView>[]>(
    () => [
      {
        header: 'Позивний',
        accessorKey: 'callsign',
        id: 'callsign',
        enableColumnFilter: true,
        size: 160,
        Cell: ({ row }) => (
          <Typography variant="body2" fontWeight={600}>
            {formatMrtCellTextValue(row.original.callsign)}
          </Typography>
        ),
      },
      {
        header: 'Посада',
        accessorKey: 'position',
        id: 'position',
        enableColumnFilter: true,
        size: 170,
        Cell: ({ row }) => formatMrtCellTextValue(row.original.position),
      },
      {
        header: 'ПІП',
        accessorKey: 'fullName',
        id: 'fullName',
        enableColumnFilter: true,
        size: 240,
        Cell: ({ row }) => <CommentCell comment={row.original.fullName} />,
      },
      {
        header: 'Коментар',
        accessorKey: 'comment',
        id: 'comment',
        enableColumnFilter: true,
        size: 240,
        Cell: ({ row }) => <CommentCell comment={row.original.comment} />,
      },
      {
        header: 'Підрозділ',
        accessorKey: 'unitName',
        id: 'unit',
        enableColumnFilter: true,
        size: 240,
        Cell: ({ row }) => (
          <Typography variant="body2" sx={{ maxWidth: 260 }} noWrap title={row.original.unitName}>
            {formatMrtCellTextValue(row.original.unitName)}
          </Typography>
        ),
      },
      {
        header: 'Основне джерело',
        accessorKey: 'sourceName',
        id: 'sourceName',
        enableColumnFilter: false,
        size: 260,
        Cell: ({ row }) => (
          <Stack spacing={0.75}>
            <Typography variant="body2">
              {formatMrtCellTextValue(row.original.sourceName)}
            </Typography>
            {row.original.callsignAdditionalSourceNames.length > 0 ? (
              <>
                <Typography variant="caption" color="text.secondary">
                  Підтверджено:
                </Typography>
                <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
                  {row.original.callsignAdditionalSourceIds.map((sourceId, index) => (
                    <PowerChip
                      key={`${row.original.id}-${sourceId}`}
                      label={row.original.callsignAdditionalSourceNames[index] ?? `#${sourceId}`}
                      size="small"
                      interactive={false}
                      unselectedOpacity={1}
                      unselectedBackgroundColor="transparent"
                      unselectedTextColor="text.primary"
                      unselectedBorderColor="divider"
                    />
                  ))}
                </Stack>
              </>
            ) : null}
          </Stack>
        ),
      },
      {
        header: 'Частота',
        accessorKey: 'radioFreq',
        id: 'radioFreq',
        enableColumnFilter: false,
        size: 130,
        Cell: ({ row }) => formatMrtCellTextValue(row.original.radioFreq),
      },
      {
        header: 'Статус',
        accessorFn: (row) => (row.developing ? 'В дорозвідці' : 'Відомий'),
        id: 'developing',
        meta: {
          activeFilterDefaultValue: ['Відомий'],
        },
        filterVariant: 'select',
        filterSelectOptions: [...STATUS_FILTER_OPTIONS],
        Filter: buildExplicitSingleSelectColumnFilter<CallsignRowView>({
          options: STATUS_FILTER_OPTIONS,
          fallbackValue: 'Відомий',
          helperText: getFilterModeHelperText('select'),
          onChange: (column, nextValue) => {
            column.setFilterValue([nextValue]);
          },
        }),
        enableSorting: false,
        size: 170,
        Cell: ({ row }) => (
          <PowerChip
            label={row.original.developing ? 'Дорозвідка' : 'Відомий'}
            size="small"
            interactive={false}
            unselectedOpacity={1}
            unselectedBackgroundColor={row.original.developing ? 'warning.main' : 'transparent'}
            unselectedTextColor={row.original.developing ? 'warning.contrastText' : 'text.primary'}
            unselectedBorderColor={row.original.developing ? 'warning.main' : 'divider'}
          />
        ),
      },
      {
        header: 'Додано',
        accessorKey: 'createdAt',
        id: 'createdAt',
        enableColumnFilter: false,
        sortDescFirst: true,
        size: 150,
        Cell: ({ row }) => formatDateTime(row.original.createdAt),
      },
    ],
    [],
  );

  const rowSelection = useMemo(
    () =>
      rows.reduce<Record<string, boolean>>((acc, row) => {
        if (selectedCallsignIds.includes(row.id)) {
          acc[String(row.id)] = true;
        }
        return acc;
      }, {}),
    [rows, selectedCallsignIds],
  );
  const columnFilters = useMemo<MRT_ColumnFiltersState>(
    () => [
      ...(textFilters.filterCallsign.trim()
        ? [{ id: 'callsign', value: textFilters.filterCallsign }]
        : []),
      ...(textFilters.filterPosition.trim()
        ? [{ id: 'position', value: textFilters.filterPosition }]
        : []),
      ...(textFilters.filterFullName.trim()
        ? [{ id: 'fullName', value: textFilters.filterFullName }]
        : []),
      ...(textFilters.filterComment.trim()
        ? [{ id: 'comment', value: textFilters.filterComment }]
        : []),
      ...(textFilters.filterUnit.trim() ? [{ id: 'unit', value: textFilters.filterUnit }] : []),
      { id: 'developing', value: toStatusFilterValue(statusFilter) },
    ],
    [
      statusFilter,
      textFilters.filterCallsign,
      textFilters.filterPosition,
      textFilters.filterFullName,
      textFilters.filterComment,
      textFilters.filterUnit,
    ],
  );
  const showTableOverlay = loading || refreshing || loadingMore;
  const isInitialLoading = loading && rows.length === 0;

  const syncTableContainerOverflow = useCallback(() => {
    const element = tableContainerRef.current;
    if (!element) return;

    const hasVerticalOverflow = element.scrollHeight - element.clientHeight > 1;
    setTableContainerHasVerticalOverflow((prev) =>
      prev === hasVerticalOverflow ? prev : hasVerticalOverflow,
    );
  }, []);

  useLayoutEffect(() => {
    syncTableContainerOverflow();

    const element = tableContainerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(syncTableContainerOverflow);
    observer.observe(element);
    const tableElement = element.querySelector('table');
    if (tableElement) observer.observe(tableElement);

    return () => observer.disconnect();
  }, [rows, syncTableContainerOverflow, tableStateContext.columnSizing, tableStateContext.density]);

  const syncOverlayViewport = useCallback(() => {
    const element = scrollContainerRef.current;
    if (!element) return;

    setOverlayViewport({
      top: element.scrollTop,
      left: element.scrollLeft,
      width: element.clientWidth,
      height: element.clientHeight,
    });
  }, []);

  useEffect(() => {
    syncOverlayViewport();
  }, [syncOverlayViewport, showTableOverlay]);

  const table = useMaterialReactTable({
    columns,
    data: rows,
    ...defaultMRTOptions,
    enableSorting: true,
    enableSortingRemoval: false,
    manualSorting: true,
    manualFiltering: true,
    enableColumnActions: true,
    enableColumnFilters: true,
    enableColumnFilterModes: false,
    enableFacetedValues: false,
    enableRowVirtualization: false,
    enablePagination: false,
    enableBottomToolbar: false,
    enableTopToolbar: false,
    enableDensityToggle: false,
    enableHiding: true,
    enableRowNumbers: true,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    enableRowSelection: (row) =>
      canEdit && !bulkDeleteInFlight && inFlightDeleteId !== row.original.id,
    enableMultiRowSelection: true,
    enableSelectAll: true,
    enableRowActions: canEdit,
    positionActionsColumn: canEdit ? 'first' : undefined,
    columnFilterDisplayMode: 'popover',
    muiFilterTextFieldProps: ({ column }) => ({
      ...getSharedFilterTextFieldProps(column.columnDef.filterVariant),
      helperText: getFilterModeHelperText(column.columnDef.filterVariant),
    }),
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onSortingChange: (updater) => {
      const nextSorting = resolveUpdater(updater, toMrtSorting(sort));
      const next = nextSorting[0];
      if (!next) return;
      const nextColumn =
        next.id === 'callsign' ||
        next.id === 'position' ||
        next.id === 'fullName' ||
        next.id === 'comment' ||
        next.id === 'unit' ||
        next.id === 'sourceName' ||
        next.id === 'radioFreq' ||
        next.id === 'createdAt'
          ? next.id
          : sort.column;
      const nextDirection = next.desc ? 'desc' : 'asc';
      if (nextColumn === sort.column && nextDirection === sort.direction) return;
      onSort(nextColumn, nextDirection);
    },
    onColumnFiltersChange: (updater) => {
      const nextFilters = resolveUpdater(updater, columnFilters);
      const nextStatusFilter = nextFilters.find((item) => item.id === 'developing');
      onTextColumnFiltersChange({
        filterCallsign: getStringColumnFilterValue(nextFilters, 'callsign'),
        filterPosition: getStringColumnFilterValue(nextFilters, 'position'),
        filterFullName: getStringColumnFilterValue(nextFilters, 'fullName'),
        filterComment: getStringColumnFilterValue(nextFilters, 'comment'),
        filterUnit: getStringColumnFilterValue(nextFilters, 'unit'),
      });
      onStatusFilterChange(fromStatusFilterValue(nextStatusFilter?.value));
    },
    onRowSelectionChange: (updater) => {
      const nextSelection = resolveUpdater(updater, rowSelection);
      const nextIds = rows.filter((row) => nextSelection[String(row.id)]).map((row) => row.id);
      onSetSelectedCallsignIds(nextIds);
    },
    renderRowActions: ({ row }) => (
      <Box sx={{ display: 'flex', justifyContent: 'center' }}>
        <MrtRowActions>
          <MrtRowActionButton
            label="Редагувати"
            onClick={() => onEdit(row.original)}
            disabled={!canEdit || inFlightDeleteId === row.original.id || bulkDeleteInFlight}
            icon={<EditIcon fontSize="small" />}
            opensModal
          />
          <MrtRowActionButton
            label="Видалити"
            onClick={() => onDelete(row.original)}
            disabled={!canEdit || inFlightDeleteId === row.original.id || bulkDeleteInFlight}
            icon={<DeleteIcon fontSize="small" />}
            tone="danger"
            opensModal
          />
        </MrtRowActions>
      </Box>
    ),
    renderEmptyRowsFallback: ({ table }) =>
      renderDefaultMrtEmptyRowsFallback({
        table,
        hasFilters: hasActiveFilters,
        noDataMessage: 'Позивні відсутні',
        filteredMessage: 'Немає позивних за обраними фільтрами',
        onClearFilters,
      }),
    defaultColumn: {
      size: 180,
      renderColumnActionsMenuItems,
    },
    initialState: {
      pagination: {
        pageIndex: 0,
        pageSize: 20,
      },
    },
    localization: {
      ...defaultMRTOptions.localization,
      select: '',
      toggleSelectAll: 'Вибрати всі рядки',
      toggleSelectRow: 'Вибрати рядок',
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: mrtRowActionsColumnSize(2),
      },
    },
    muiTablePaperProps: ({ table }) => {
      const isFullScreen = table.getState().isFullScreen;
      const paperProps = getDefaultMrtPaperProps({
        table,
        loading: showTableOverlay,
        layout: isFullScreen || isInitialLoading ? 'workspace' : 'list',
      });
      return {
        ...paperProps,
        sx: {
          ...(paperProps as { sx?: object })?.sx,
          minHeight: isInitialLoading ? '100%' : 0,
          overflow: 'hidden',
        },
        style: {
          ...(paperProps as { style?: CSSProperties })?.style,
          padding: 0,
        },
      };
    },
    muiTableContainerProps: ({ table }) => {
      const isFullScreen = table.getState().isFullScreen;
      const containerProps = getDefaultMrtContainerProps({
        loading: showTableOverlay,
        layout: isFullScreen || isInitialLoading ? 'workspace' : 'list',
        fullScreen: isFullScreen,
        hasRows: rows.length > 0,
      });

      return {
        ...containerProps,
        ref: tableContainerRef,
        sx: {
          ...(containerProps as { sx?: object })?.sx,
          minHeight: isInitialLoading ? '100%' : 0,
          overflowX: showTableOverlay ? 'hidden' : 'auto',
          overflowY: getCallsignsTableContainerOverflowY({
            hasVerticalOverflow: tableContainerHasVerticalOverflow,
            showTableOverlay,
          }),
          overflow: undefined,
          border: 0,
        },
      };
    },
    muiTableBodyRowProps: ({ row }) => ({
      hover: true,
      sx: {
        opacity: inFlightDeleteId === row.original.id ? 0.6 : 1,
      },
    }),
    muiTableHeadCellProps: ({ column }) => ({
      sx: {
        ...CUSTOM_STYLES.muiTableHeadCellProps.sx,
        backgroundColor: 'inherit !important',
        ...(column.id === 'developing'
          ? {
              '& .Mui-TableHeadCell-FilterLabel': {
                display: 'inline-flex',
              },
            }
          : {}),
      },
    }),
    state: {
      showAlertBanner: false,
      showLoadingOverlay: false,
      density: tableStateContext.density,
      columnVisibility: tableStateContext.columnVisibility,
      columnOrder: tableStateContext.columnOrder,
      columnSizing: tableStateContext.columnSizing,
      sorting: toMrtSorting(sort),
      columnFilters,
      rowSelection,
      isLoading: loading,
      showSkeletons: loading,
      showProgressBars: !loading && (refreshing || loadingMore),
    },
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table, tableStateContext]);

  const isFullScreen = table.getState().isFullScreen;

  return (
    <Box
      ref={scrollContainerRef}
      onScroll={showTableOverlay ? undefined : syncOverlayViewport}
      sx={{
        position: 'relative',
        height: '100%',
        minHeight: 0,
        overflowY: showTableOverlay ? 'hidden' : 'auto',
        overflowX: showTableOverlay ? 'hidden' : 'auto',
        border: '1px solid',
        borderColor: 'var(--bs-border-color)',
        backgroundColor: 'var(--bs-body-bg)',
        '& .MuiTableHead-root': {
          position: 'sticky !important',
          top: '0 !important',
          zIndex: '4 !important',
          backgroundColor: 'var(--bs-body-bg) !important',
        },
        '& .MuiTableHead-root .MuiTableRow-root': {
          backgroundColor: 'inherit !important',
          borderBottom: '1px solid',
          borderColor: 'var(--bs-border-color)',
        },
        '& .MuiTableHead-root .MuiTableCell-head': {
          backgroundColor: 'inherit !important',
          borderBottom: '0 !important',
        },
        '& .MuiTable-root': {
          width: '100%',
        },
        '& .MuiTableBody-root .MuiTableRow-root:last-of-type td': {
          borderBottom: showLoadMore ? '0 !important' : undefined,
        },
      }}
    >
      {showTableOverlay ? (
        <SectionLoadingOverlay
          open={showTableOverlay}
          ariaLabel={
            loading
              ? 'Завантаження позивних'
              : loadingMore
                ? 'Завантаження позивних'
                : 'Оновлення позивних'
          }
          showSpinner={!isInitialLoading}
          sx={{
            inset: 'auto',
            top: `${overlayViewport.top}px`,
            left: `${overlayViewport.left}px`,
            width: `${overlayViewport.width}px`,
            height: `${overlayViewport.height}px`,
            zIndex: 12,
          }}
        />
      ) : null}

      <Box
        sx={{
          position: 'relative',
          minHeight: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {isFullScreen ? (
          <Tooltip title="Вийти з повноекранного режиму">
            <Button
              onClick={() => table.setIsFullScreen(false)}
              aria-label="Вийти з повноекранного режиму"
              variant="outlined"
              startIcon={<FullscreenExitIcon />}
              sx={{
                position: 'fixed',
                bottom: 16,
                right: 16,
                zIndex: 1401,
                backgroundColor: 'var(--bs-body-bg)',
                whiteSpace: 'nowrap',
                '&:hover': {
                  backgroundColor: 'var(--bs-body-bg)',
                },
              }}
            >
              Вийти з повноекранного
            </Button>
          </Tooltip>
        ) : null}

        <MaterialReactTable table={table} />

        {showLoadMore ? (
          <Box
            sx={{
              borderTop: '1px solid',
              borderColor: 'var(--bs-border-color)',
              display: 'flex',
              justifyContent: 'center',
              p: '10px',
            }}
          >
            <Button
              variant="outlined"
              onClick={onLoadMore}
              disabled={loading || loadingMore}
              startIcon={loadingMore ? <CircularProgress color="inherit" size={16} /> : null}
            >
              {loadingMore ? `Завантаження${ELLIPSIS}` : 'Завантажити ще'}
            </Button>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

function areTextFiltersEqual(left: Props['textFilters'], right: Props['textFilters']): boolean {
  return (
    left.filterCallsign === right.filterCallsign &&
    left.filterPosition === right.filterPosition &&
    left.filterFullName === right.filterFullName &&
    left.filterComment === right.filterComment &&
    left.filterUnit === right.filterUnit
  );
}

function areCallsignsTablePropsEqual(prev: Props, next: Props): boolean {
  return (
    prev.canEdit === next.canEdit &&
    prev.rows === next.rows &&
    prev.loading === next.loading &&
    prev.refreshing === next.refreshing &&
    prev.loadingMore === next.loadingMore &&
    prev.showLoadMore === next.showLoadMore &&
    prev.hasActiveFilters === next.hasActiveFilters &&
    areTextFiltersEqual(prev.textFilters, next.textFilters) &&
    prev.inFlightDeleteId === next.inFlightDeleteId &&
    prev.bulkDeleteInFlight === next.bulkDeleteInFlight &&
    prev.selectedCallsignIds === next.selectedCallsignIds &&
    prev.sort.column === next.sort.column &&
    prev.sort.direction === next.sort.direction &&
    prev.statusFilter === next.statusFilter
  );
}

export const CallsignsTable = memo(CallsignsTableComponent, areCallsignsTablePropsEqual);
