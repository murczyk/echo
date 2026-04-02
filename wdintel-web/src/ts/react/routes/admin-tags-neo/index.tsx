import EditIcon from '@mui/icons-material/Edit';
import { Box, CircularProgress, Stack } from '@mui/material';
import { MRT_ColumnDef, MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import { useEffect, useMemo, useState } from 'react';

import { TagAdmin } from '../../../../Bindings';
import { PageErrorState } from '../../components/PageErrorState';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { TableContentState } from '../../components/TableContentState';
import { MrtRowActionButton, mrtRowActionsColumnSize } from '../../components/MrtRowActionButton';
import { Button } from '../../components/mui-customized/button';
import {
  CUSTOM_CELL_STYLES,
  CUSTOM_STYLES,
  FULL_HEIGHT_LOADING_ROW_COUNT,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../components/mui-customized/table/custom-styles';
import {
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import { TableStateProvider, useTableStateContext } from '../../components/mui-customized/table/table-state-provider';
import { listTags } from '../../services/api/tags';
import { navigateWithinSpa, withBackTo } from '../../utils/browser';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

const DEFAULT_COLUMNS_VISIBILITY = {
  tagId: true,
  label: true,
  extra: true,
  ord: true,
  enabled: true,
  keywordsCount: true,
};

const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'tagId',
  'label',
  'extra',
  'ord',
  'enabled',
  'keywordsCount',
];

const defaultMRTOptions = getDefaultMRTOptions<TagAdmin>();

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

function buildEditHref(tagId: number): string {
  return withBackTo(`/admin/tags-neo/edit?id=${tagId}`);
}

function buildCreateHref(): string {
  return withBackTo('/admin/tags-neo/edit');
}

function buildTagLoadingRows(): TagAdmin[] {
  return Array.from({ length: FULL_HEIGHT_LOADING_ROW_COUNT }, (_, index) => ({
    tagId: -index - 1,
    label: '',
    extra: null,
    ord: null,
    enabled: false,
    keywords: [],
    isPalitra: false,
  }));
}

function useTagColumns(): MRT_ColumnDef<TagAdmin>[] {
  return useMemo(
    () => [
      {
        header: 'ID',
        accessorKey: 'tagId',
        size: 80,
      },
      {
        header: 'Назва',
        accessorKey: 'label',
        size: 220,
      },
      {
        header: 'Додатковий',
        accessorFn: (row) => (row.extra ? 'так' : 'ні'),
        id: 'extra',
        size: 120,
      },
      {
        header: 'Порядок',
        accessorFn: (row) => (row.ord === null ? '—' : row.ord),
        id: 'ord',
        size: 100,
      },
      {
        header: 'Активний',
        accessorFn: (row) => (row.enabled ? 'так' : 'ні'),
        id: 'enabled',
        size: 120,
      },
      {
        header: 'Ключові слова',
        accessorFn: (row) => row.keywords?.length ?? 0,
        id: 'keywordsCount',
        size: 140,
      },
    ],
    [],
  );
}

function RowActions(props: { tag: TagAdmin }) {
  return (
    <MrtRowActionButton
      label="Редагувати"
      onClick={() => navigateWithinSpa(buildEditHref(props.tag.tagId))}
      icon={<EditIcon fontSize="small" />}
    />
  );
}

function TagsTable(props: { data: TagAdmin[]; loading: boolean }) {
  const tableStateContext = useTableStateContext();
  const columns = useTagColumns();
  const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
  const resolvedPaperProps = typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

  const state = {
    showAlertBanner: false,
    showLoadingOverlay: false,
    showSkeletons: props.loading,
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
    data: props.loading ? buildTagLoadingRows() : props.data,
    ...defaultMRTOptions,
    enableSorting: true,
    enableColumnActions: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
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
    getColumnCanGlobalFilter: (column) => column.getIsVisible(),
    enableRowActions: !props.loading,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) => <RowActions tag={row.original} />,
    defaultColumn: {
      size: 160,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: mrtRowActionsColumnSize(1),
      },
      'mrt-row-numbers': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-numbers'],
        muiTableBodyCellProps: () => ({
          sx: {
            justifyContent: 'center',
            ...CUSTOM_CELL_STYLES,
          },
        }),
      },
    },
    muiTablePaperProps: ({ table }) => {
      const baseProps = resolvedPaperProps({ table });
      return {
        ...baseProps,
        sx: {
          ...(baseProps as any)?.sx,
          ...FULL_WIDTH_TABLE_PAPER_SX,
        },
      };
    },
    muiTableContainerProps: {
      sx: {
        ...(CUSTOM_STYLES.muiTableContainerProps as any)?.sx,
        ...getPageScrollTableContainerSx({ loading: props.loading, idleOverflow: 'auto' }),
      },
    },
    state,
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}

function AdminTagsNeoPageBody() {
  const [tags, setTags] = useState<TagAdmin[]>([]);
  const [status, setStatus] = useState<LoadingStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  async function loadTags() {
    setStatus('loading');
    setError(null);
    try {
      const data = await listTags();
      setTags(data);
      setStatus('success');
    } catch (err) {
      setStatus('error');
      setError(formatErrorMessage(err));
    }
  }

  useEffect(() => {
    loadTags();
  }, []);

  const renderTable = () => {
    return (
      <TableContentState
        status={status}
        errorMessage={error || 'Помилка завантаження'}
        loadingContent={
          <div className="flex w-full min-w-0 flex-1 min-h-0">
            <TagsTable data={tags} loading />
          </div>
        }
      >
        <div className="flex w-full min-w-0 flex-1 min-h-0">
          <TagsTable data={tags} loading={false} />
        </div>
      </TableContentState>
    );
  };

  return (
    <Box className="w-full" sx={{ height: { xs: 'auto', lg: '100%' }, minHeight: 0, overflow: { xs: 'visible', lg: 'hidden' } }}>
      <Stack spacing={3} useFlexGap sx={{ height: { xs: 'auto', lg: '100%' }, minHeight: 0, overflow: { xs: 'visible', lg: 'hidden' } }}>
      <TablePageToolbar
        title="Теги"
        withGlobalTextFilter
        hideGlobalTextFilter={status !== 'success'}
        internalActionsDisabled={status !== 'success'}
        actions={
          <div className="flex gap-3">
            <Button variant="contained" onClick={() => navigateWithinSpa(buildCreateHref())}>
              Створити тег
            </Button>
          </div>
        }
      />

      <Box sx={{ flex: 1, minHeight: { xs: 'auto', lg: 0 }, minWidth: 0, display: 'flex' }}>{renderTable()}</Box>
      </Stack>
    </Box>
  );
}

export function AdminTagsNeoPage() {
  return (
    <TableStateProvider
      tableId="admin-tags-neo"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <AdminTagsNeoPageBody />
    </TableStateProvider>
  );
}
