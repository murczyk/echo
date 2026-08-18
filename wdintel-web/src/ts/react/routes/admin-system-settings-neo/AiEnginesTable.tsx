import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { Box, Chip, Stack, Tooltip } from '@mui/material';
import {
  MaterialReactTable,
  type MRT_ColumnDef,
  useMaterialReactTable,
} from 'material-react-table';
import { useEffect, useMemo } from 'react';

import type { AiEngineItem } from '../../../../Bindings';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import { PowerButton } from '../../components/PowerButton';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import {
  CUSTOM_CELL_STYLES,
  CUSTOM_STYLES,
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../components/mui-customized/table/custom-styles';
import {
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import { AI_AGENT_TOKEN_WARNING } from '../admin-ai-agent/engine-eligibility';

const ROW_ACTIONS_COLUMN_SIZE = 96;
const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'name',
  'modelName',
  'url',
  'enabled',
  'callsignEnabled',
  'ocrEnabled',
  'hasToken',
  'updatedAt',
];
const AI_AGENT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'name',
  'aiAgentCompatibility',
  'modelName',
  'url',
  'enabled',
  'hasToken',
  'updatedAt',
];
const DEFAULT_COLUMN_VISIBILITY = {
  name: true,
  modelName: true,
  url: true,
  enabled: true,
  callsignEnabled: true,
  ocrEnabled: true,
  hasToken: true,
  updatedAt: true,
};
const AI_AGENT_COLUMN_VISIBILITY = {
  ...DEFAULT_COLUMN_VISIBILITY,
  aiAgentCompatibility: true,
};
const defaultMRTOptions = getDefaultMRTOptions<AiEngineItem>();

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('uk-UA', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(timestamp);
}

type Props = {
  aiEngines: AiEngineItem[];
  getCompatibility?: AiEngineCompatibilityResolver;
  onCreate: () => void;
  onDelete: (aiEngine: AiEngineItem) => void;
  onEdit: (aiEngine: AiEngineItem) => void;
  onView: (aiEngine: AiEngineItem) => void;
};

export type AiEngineCompatibilityResolver = (aiEngine: AiEngineItem) => {
  compatible: boolean;
  explanation: string;
};

export function AiEngineCompatibilityStatus({
  aiEngine,
  getCompatibility,
}: {
  aiEngine: AiEngineItem;
  getCompatibility: AiEngineCompatibilityResolver;
}) {
  const compatibility = getCompatibility(aiEngine);
  const explanation = aiEngine.hasToken
    ? `${AI_AGENT_TOKEN_WARNING} ${compatibility.explanation}`
    : compatibility.explanation;
  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <Chip
        size="small"
        label={compatibility.compatible ? 'Сумісний' : 'Несумісний'}
        color={compatibility.compatible ? 'success' : 'warning'}
      />
      <Tooltip title={explanation} arrow>
        <Box
          component="span"
          aria-label={explanation}
          sx={{ display: 'inline-flex', color: 'text.secondary', cursor: 'default', lineHeight: 0 }}
        >
          <InfoOutlinedIcon color={aiEngine.hasToken ? 'error' : 'inherit'} sx={{ fontSize: 16 }} />
        </Box>
      </Tooltip>
    </Stack>
  );
}

function AiEnginesTableBody({
  aiEngines,
  getCompatibility,
  onCreate,
  onDelete,
  onEdit,
  onView,
}: Props) {
  const tableStateContext = useTableStateContext();
  const columns = useMemo<MRT_ColumnDef<AiEngineItem>[]>(
    () => [
      { accessorKey: 'name', header: 'Назва', size: 180 },
      ...(getCompatibility
        ? [
            {
              id: 'aiAgentCompatibility',
              accessorFn: (aiEngine: AiEngineItem) =>
                getCompatibility(aiEngine).compatible ? 'Сумісний' : 'Несумісний',
              header: 'ШІ агент',
              size: 160,
              Cell: ({ row }: { row: { original: AiEngineItem } }) => (
                <AiEngineCompatibilityStatus
                  aiEngine={row.original}
                  getCompatibility={getCompatibility}
                />
              ),
            } satisfies MRT_ColumnDef<AiEngineItem>,
          ]
        : []),
      { accessorKey: 'modelName', header: 'Модель', size: 220 },
      { accessorKey: 'url', header: 'URL', size: 320 },
      {
        id: 'enabled',
        accessorFn: (aiEngine) => (aiEngine.enabled ? 'Увімкнено' : 'Вимкнено'),
        header: 'Стан',
        size: 140,
      },
      {
        id: 'callsignEnabled',
        accessorFn: (aiEngine) => (aiEngine.callsignEnabled ? 'Так' : 'Ні'),
        header: 'Позивні',
        size: 120,
      },
      {
        id: 'ocrEnabled',
        accessorFn: (aiEngine) => (aiEngine.ocrEnabled ? 'Так' : 'Ні'),
        header: 'OCR',
        size: 100,
      },
      {
        id: 'hasToken',
        accessorFn: (aiEngine) => (aiEngine.hasToken ? 'Задано' : 'Не задано'),
        header: 'Токен',
        size: 140,
      },
      {
        id: 'updatedAt',
        accessorFn: (aiEngine) => formatDate(aiEngine.updatedAt),
        header: 'Оновлено',
        size: 180,
      },
    ],
    [getCompatibility],
  );
  const table = useMaterialReactTable({
    columns,
    data: aiEngines,
    ...defaultMRTOptions,
    enableSorting: true,
    enableColumnActions: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowActions: true,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) => (
      <Stack direction="row" spacing={0.5}>
        <MrtRowActionButton
          label="Переглянути"
          icon={<VisibilityOutlinedIcon fontSize="small" />}
          onClick={() => onView(row.original)}
        />
        <MrtRowActions forceMenu>
          <MrtRowActionButton
            label="Редагувати"
            icon={<EditOutlinedIcon fontSize="small" />}
            onClick={() => onEdit(row.original)}
          />
          <MrtRowActionButton
            label="Видалити"
            icon={<DeleteOutlineIcon fontSize="small" />}
            onClick={() => onDelete(row.original)}
            tone="danger"
            opensModal
          />
        </MrtRowActions>
      </Stack>
    ),
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
    defaultColumn: { size: 200, renderColumnActionsMenuItems },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: ROW_ACTIONS_COLUMN_SIZE,
        minSize: ROW_ACTIONS_COLUMN_SIZE,
        maxSize: ROW_ACTIONS_COLUMN_SIZE,
      },
      'mrt-row-numbers': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-numbers'],
        muiTableBodyCellProps: () => ({
          sx: { justifyContent: 'center', ...CUSTOM_CELL_STYLES },
        }),
      },
    },
    muiTablePaperProps: ({ table }) =>
      getDefaultMrtPaperProps({ table, loading: false, layout: 'workspace' }),
    muiTableContainerProps: ({ table }) =>
      getDefaultMrtContainerProps({
        loading: false,
        layout: 'workspace',
        fullScreen: table.getState().isFullScreen,
        hasRows: aiEngines.length > 0,
      }),
    state: {
      showAlertBanner: false,
      globalFilter: tableStateContext.globalFilter,
      columnVisibility: tableStateContext.columnVisibility,
      columnFilters: tableStateContext.columnFilters,
      density: tableStateContext.density,
      sorting: tableStateContext.sorting,
      columnOrder: tableStateContext.columnOrder,
      columnSizing: tableStateContext.columnSizing,
    },
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return (
    <Stack spacing={2}>
      <TablePageToolbar
        title="Провайдери ШІ"
        titleInfo="OpenAI та OpenAI-сумісні vLLM API"
        withGlobalTextFilter
        actions={
          <PowerButton type="button" variant="contained" onClick={onCreate} startIcon={<AddIcon />}>
            Додати
          </PowerButton>
        }
      />
      <MaterialReactTable table={table} />
    </Stack>
  );
}

export function AiEnginesTable(props: Props) {
  return (
    <TableStateProvider
      tableId="admin-ai-providers"
      defaultColumnOrder={props.getCompatibility ? AI_AGENT_COLUMN_ORDER : DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={
        props.getCompatibility ? AI_AGENT_COLUMN_VISIBILITY : DEFAULT_COLUMN_VISIBILITY
      }
      defaultEnableColumnOrdering={false}
    >
      <AiEnginesTableBody {...props} />
    </TableStateProvider>
  );
}
