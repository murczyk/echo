import {
  Box,
  Button,
  CircularProgress,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  MRT_ColumnDef,
  MaterialReactTable,
  useMaterialReactTable,
} from 'material-react-table';
import { useEffect, useMemo } from 'react';

import { TableEmptyState } from '../../components/TableEmptyState';
import {
  CUSTOM_STYLES,
  FULL_WIDTH_TABLE_PAPER_SX,
  PAGE_SCROLL_TABLE_CONTAINER_SX,
} from '../../components/mui-customized/table/custom-styles';
import {
  buildDefaultColumnOrder,
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import { useTableStateContext } from '../../components/mui-customized/table/table-state-provider';
import { formatMrtCellTextValue } from '../../components/formatMrtCellTextValue';
import { GoiKnowledgeRowView } from './use-goi-knowledge-page';

const defaultMRTOptions = getDefaultMRTOptions<GoiKnowledgeRowView>();

export const DEFAULT_GOI_KNOWLEDGE_COLUMN_VISIBILITY = {
  sourceKnowledgeId: true,
  sourceCreatedAt: true,
  name: true,
  key: true,
  knowledgeType: true,
  author: true,
  formation: true,
  sourceDate: true,
  note: true,
  createdAt: true,
};

export const DEFAULT_GOI_KNOWLEDGE_COLUMN_ORDER = buildDefaultColumnOrder({
  dataColumnIds: [
    'sourceKnowledgeId',
    'sourceCreatedAt',
    'name',
    'key',
    'knowledgeType',
    'author',
    'formation',
    'sourceDate',
    'note',
    'createdAt',
  ],
  withRowNumbers: true,
});

type Props = {
  rows: GoiKnowledgeRowView[];
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  showLoadMore: boolean;
  hasActiveFilters: boolean;
  onLoadMore: () => void;
  onClearFilters: () => void;
};

function LongTextCell({
  value,
  maxWidth,
}: {
  value: string | null | undefined;
  maxWidth: number;
}) {
  const text = formatMrtCellTextValue(value);
  if (text === '—' || text.length <= 90) {
    return (
      <Typography variant="body2" sx={{ maxWidth }} noWrap={text.length > 40}>
        {text}
      </Typography>
    );
  }

  return (
    <Tooltip title={text} placement="top-start">
      <Typography variant="body2" sx={{ maxWidth }} noWrap>
        {text}
      </Typography>
    </Tooltip>
  );
}

export function GoiKnowledgeTable(props: Props) {
  const tableStateContext = useTableStateContext();
  const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
  const resolvedPaperProps =
    typeof basePaperProps === 'function'
      ? basePaperProps
      : () => basePaperProps || {};

  const columns = useMemo<MRT_ColumnDef<GoiKnowledgeRowView>[]>(
    () => [
      {
        header: 'ID ГОІ',
        accessorKey: 'sourceKnowledgeId',
        id: 'sourceKnowledgeId',
        enableColumnFilter: false,
        size: 90,
      },
      {
        header: 'Дата в ГОІ',
        accessorKey: 'sourceCreatedAtLabel',
        id: 'sourceCreatedAt',
        enableColumnFilter: false,
        size: 170,
        Cell: ({ row }) => row.original.sourceCreatedAtLabel,
      },
      {
        header: 'Назва',
        accessorKey: 'name',
        id: 'name',
        enableColumnFilter: true,
        size: 180,
        Cell: ({ row }) => formatMrtCellTextValue(row.original.name),
      },
      {
        header: 'Ключ',
        accessorKey: 'key',
        id: 'key',
        enableColumnFilter: true,
        size: 140,
        Cell: ({ row }) => formatMrtCellTextValue(row.original.key),
      },
      {
        header: 'Тип',
        accessorKey: 'knowledgeType',
        id: 'knowledgeType',
        enableColumnFilter: true,
        size: 160,
        Cell: ({ row }) => formatMrtCellTextValue(row.original.knowledgeType),
      },
      {
        header: 'Автор',
        accessorKey: 'author',
        id: 'author',
        enableColumnFilter: true,
        size: 150,
        Cell: ({ row }) => formatMrtCellTextValue(row.original.author),
      },
      {
        header: 'Підрозділ',
        accessorKey: 'formation',
        id: 'formation',
        enableColumnFilter: true,
        size: 220,
        Cell: ({ row }) => (
          <LongTextCell value={row.original.formation} maxWidth={220} />
        ),
      },
      {
        header: 'Дата джерела',
        accessorKey: 'sourceDateLabel',
        id: 'sourceDate',
        enableColumnFilter: false,
        size: 170,
        Cell: ({ row }) => row.original.sourceDateLabel,
      },
      {
        header: 'Нотатка',
        accessorKey: 'note',
        id: 'note',
        enableColumnFilter: true,
        size: 420,
        Cell: ({ row }) => <LongTextCell value={row.original.note} maxWidth={420} />,
      },
      {
        header: 'Імпортовано',
        accessorKey: 'createdAtLabel',
        id: 'createdAt',
        enableColumnFilter: false,
        size: 170,
        Cell: ({ row }) => row.original.createdAtLabel,
      },
    ],
    [],
  );

  const table = useMaterialReactTable({
    columns,
    data: props.rows,
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
    columnFilterDisplayMode: 'popover',
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onSortingChange: tableStateContext.onSortingChange,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
    renderEmptyRowsFallback: () => (
      <Box sx={{ py: 6 }}>
        <TableEmptyState
          message={
            props.hasActiveFilters
              ? 'Немає записів інформованості за обраними фільтрами'
              : 'Записи інформованості відсутні'
          }
          actionLabel={props.hasActiveFilters ? 'Очистити фільтри' : undefined}
          onAction={props.hasActiveFilters ? props.onClearFilters : undefined}
        />
      </Box>
    ),
    defaultColumn: {
      size: 180,
      renderColumnActionsMenuItems,
    },
    muiTablePaperProps: ({ table }) => {
      const baseProps = resolvedPaperProps({ table });
      return {
        ...baseProps,
        sx: {
          ...(baseProps as { sx?: object })?.sx,
          ...FULL_WIDTH_TABLE_PAPER_SX,
        },
      };
    },
    muiTableContainerProps: {
      sx: {
        ...(CUSTOM_STYLES.muiTableContainerProps as { sx?: object })?.sx,
        ...PAGE_SCROLL_TABLE_CONTAINER_SX,
      },
    },
    state: {
      showAlertBanner: false,
      showLoadingOverlay: false,
      density: tableStateContext.density,
      globalFilter: tableStateContext.globalFilter,
      columnVisibility: tableStateContext.columnVisibility,
      columnFilters: tableStateContext.columnFilters,
      sorting: tableStateContext.sorting,
      columnOrder: tableStateContext.columnOrder,
      columnSizing: tableStateContext.columnSizing,
      isLoading: props.loading,
      showSkeletons: props.loading,
      showProgressBars: !props.loading && (props.refreshing || props.loadingMore),
    },
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table, tableStateContext]);

  return (
    <Box
      sx={{
        position: 'relative',
        height: '100%',
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'auto',
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
          borderBottom: '0',
        },
      }}
    >
      <MaterialReactTable table={table} />
      {props.showLoadMore ? (
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'center',
            py: 2,
            borderTop: '1px solid',
            borderColor: 'var(--bs-border-color)',
          }}
        >
          <Button
            variant="outlined"
            onClick={props.onLoadMore}
            disabled={props.loadingMore}
            startIcon={props.loadingMore ? <CircularProgress size={16} /> : null}
          >
            {props.loadingMore ? 'Завантаження...' : 'Завантажити ще'}
          </Button>
        </Box>
      ) : null}
    </Box>
  );
}
