import EditIcon from '@mui/icons-material/Edit';
import { CircularProgress, Tooltip } from '@mui/material';
import { MRT_ColumnDef, MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import React from 'react';

import { TagAdmin } from '../../../../Bindings';
import { PageErrorState } from '../../components/PageErrorState';
import { PageLoadingState } from '../../components/PageLoadingState';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { Button } from '../../components/mui-customized/button';
import { IconButton } from '../../components/mui-customized/icon-button';
import {
  CUSTOM_CELL_STYLES,
  CUSTOM_STYLES,
  FULL_WIDTH_TABLE_PAPER_SX,
  PAGE_SCROLL_TABLE_CONTAINER_SX,
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

function useTagColumns(): MRT_ColumnDef<TagAdmin>[] {
  return React.useMemo(
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
        header: 'Ord',
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
        accessorFn: (row) => row.keywords.length,
        id: 'keywordsCount',
        size: 140,
      },
    ],
    [],
  );
}

function RowActions(props: { tag: TagAdmin }) {
  return (
    <Tooltip title="Редагувати">
      <IconButton size="small" onClick={() => navigateWithinSpa(buildEditHref(props.tag.tagId))}>
        <EditIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

function TagsTable(props: { data: TagAdmin[] }) {
  const tableStateContext = useTableStateContext();
  const columns = useTagColumns();
  const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
  const resolvedPaperProps = typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

  const state = {
    showAlertBanner: false,
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
    data: props.data,
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
    enableRowActions: true,
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
        size: 80,
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
        ...PAGE_SCROLL_TABLE_CONTAINER_SX,
      },
    },
    state,
  });

  React.useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}

function AdminTagsNeoPageBody() {
  const [tags, setTags] = React.useState<TagAdmin[]>([]);
  const [status, setStatus] = React.useState<LoadingStatus>('idle');
  const [error, setError] = React.useState<string | null>(null);

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

  React.useEffect(() => {
    loadTags();
  }, []);

  const renderTable = () => {
    if (status === 'loading') {
      return <PageLoadingState />;
    }
    if (status === 'error') {
      return <PageErrorState message={error || 'Помилка завантаження'} />;
    }
    if (status === 'success') {
      return (
        <div className="w-full min-w-0">
          <TagsTable data={tags} />
        </div>
      );
    }
    return null;
  };

  return (
    <div className="flex w-full min-w-0 flex-col gap-6">
      <TablePageToolbar
        title="Теги"
        withGlobalTextFilter
        actions={
          <div className="flex gap-2">
            <Button variant="outlined" onClick={loadTags}>
              Оновити
            </Button>
            <Button variant="contained" onClick={() => navigateWithinSpa(buildCreateHref())}>
              Створити
            </Button>
          </div>
        }
      />

      {renderTable()}
    </div>
  );
}

export function AdminTagsNeoPage() {
  return (
    <TableStateProvider
      tableId="admin-tags-neo"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
    >
      <AdminTagsNeoPageBody />
    </TableStateProvider>
  );
}
