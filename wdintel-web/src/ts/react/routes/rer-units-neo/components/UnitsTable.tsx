import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import MergeIcon from '@mui/icons-material/Merge';
import { Box, Chip, Link, Stack, Tooltip } from '@mui/material';
import {
  type MRT_ColumnDef,
  MaterialReactTable,
  useMaterialReactTable,
} from 'material-react-table';
import { useEffect, useMemo } from 'react';

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

const defaultMrtOptions = getDefaultMRTOptions<Unit>();
const ROW_ACTIONS_COLUMN_SIZE = 76;

function formatDateTime(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('uk-UA', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function useUnitColumns(attachmentUnitIds: Set<number>): MRT_ColumnDef<Unit>[] {
  return useMemo(
    () => [
      {
        header: 'Назва',
        accessorKey: 'name',
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
                {row.original.hasOrbit ? (
                  <Tooltip title="Є дані із Orbit">
                    <Link
                      href={detailsHref}
                      underline="none"
                      aria-label={`Відкрити дані Orbit підрозділу ${row.original.name}`}
                      onClick={(event) => handleNavigateWithinSpaClick(event, detailsHref)}
                      sx={{
                        display: 'inline-flex',
                        minWidth: 24,
                        minHeight: 24,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Box
                        component="img"
                        src="/img/delta-icon.webp"
                        alt=""
                        sx={{ height: 13.2 }}
                      />
                    </Link>
                  </Tooltip>
                ) : null}
              </Stack>
            </Stack>
          );
        },
      },
      { header: 'Рота/Взвод', accessorKey: 'company', size: 160 },
      { header: 'Батальйон', accessorKey: 'battalion', size: 160 },
      { header: 'Полк/Бригада', accessorKey: 'regiment', size: 180 },
      { header: 'Дивізія', accessorKey: 'division', size: 160 },
      { header: 'Корпус/Армія', accessorKey: 'army', size: 180 },
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
        size: 300,
        Cell: ({ cell }) => (
          <Box sx={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
            {String(cell.getValue() ?? '')}
          </Box>
        ),
      },
      {
        header: 'Статус',
        id: 'active',
        accessorFn: (unit) => (unit.active ? 'Активний' : 'Неактивний'),
        filterVariant: 'select',
        filterSelectOptions: ['Активний', 'Неактивний'],
        size: 130,
        Cell: ({ row }) => (
          <Chip
            label={row.original.active ? 'Активний' : 'Неактивний'}
            color={row.original.active ? 'success' : 'default'}
            size="small"
            variant={row.original.active ? 'filled' : 'outlined'}
          />
        ),
      },
    ],
    [attachmentUnitIds],
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
}: {
  units: Unit[];
  attachmentUnitIds: Set<number>;
  loading: boolean;
  canEdit: boolean;
  actionInFlight: boolean;
  onEdit: (unit: Unit) => void;
  onDelete: (unit: Unit) => void;
  onMerge: (unit: Unit) => void;
}) {
  const tableStateContext = useTableStateContext();
  const columns = useUnitColumns(attachmentUnitIds);
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
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}
