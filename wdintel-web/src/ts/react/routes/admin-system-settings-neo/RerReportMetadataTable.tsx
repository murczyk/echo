import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import RefreshIcon from '@mui/icons-material/Refresh';
import { MaterialReactTable } from 'material-react-table';
import { useEffect, useMemo, useState } from 'react';

import type { RerReportMetadataItem } from '../../../../Bindings';
import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { EchoChip } from '../../components/EchoChip';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import {
  CUSTOM_CELL_STYLES,
  CUSTOM_STYLES,
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../components/mui-customized/table/custom-styles';
import {
  type AppMrtColumnDef,
  buildDefaultColumnOrder,
  mrtItemsCell,
  renderColumnActionsMenuItems,
  useAppMaterialReactTable,
} from '../../components/mui-customized/table/get-default-table-options';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import {
  createRerReportMetadata,
  deleteRerReportMetadata,
  updateRerReportMetadata,
} from '../../services/api/rer-report-admin';
import { MetadataEditor, type EditorState } from './RerReportMetadataEditor';

const DEFAULT_COLUMN_ORDER = buildDefaultColumnOrder({
  dataColumnIds: ['sigintUnitName', 'locations', 'labels'],
  withRowNumbers: true,
  withRowActions: true,
});
const DEFAULT_COLUMN_VISIBILITY = {
  sigintUnitName: true,
  locations: true,
  labels: true,
};
const ROW_ACTIONS_COLUMN_SIZE = 56;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

function normalizeValues(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function sortRows(rows: RerReportMetadataItem[]): RerReportMetadataItem[] {
  return [...rows].sort(
    (left, right) =>
      left.sigintUnitName.localeCompare(right.sigintUnitName, 'uk') || left.id - right.id,
  );
}

function MetadataTable({
  rows,
  loading,
  onEdit,
  onDelete,
}: {
  rows: RerReportMetadataItem[];
  loading: boolean;
  onEdit: (row: RerReportMetadataItem) => void;
  onDelete: (row: RerReportMetadataItem) => void;
}) {
  const tableStateContext = useTableStateContext();
  const columns = useMemo<AppMrtColumnDef<RerReportMetadataItem>[]>(
    () => [
      {
        id: 'sigintUnitName',
        accessorFn: (row) =>
          `${row.sigintUnitName}${row.sigintUnitDeleted ? ' (видалено)' : !row.sigintUnitActive ? ' (неактивний)' : ''}`,
        header: 'Підрозділ',
        size: 280,
      },
      {
        id: 'locations',
        accessorFn: (row) => row.locations.join(', '),
        header: 'Райони розташування',
        size: 320,
        meta: { overflowMode: 'items' },
        Cell: mrtItemsCell<RerReportMetadataItem, string>({
          items: ({ row }) => row.original.locations,
          renderItem: (location) => <EchoChip label={location} tone="neutral" />,
          measurementScope: 'admin-rer-report:locations',
          getItemKey: (location) => location,
          getItemText: (location) => location,
        }),
      },
      {
        id: 'labels',
        accessorFn: (row) => row.reportName,
        header: 'Назва для звіту',
        size: 320,
      },
    ],
    [],
  );
  const table = useAppMaterialReactTable({
    columns,
    data: rows,
    enableSorting: true,
    enableColumnActions: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowActions: true,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) => (
      <MrtRowActions>
        <MrtRowActionButton
          label="Редагувати"
          icon={<EditIcon fontSize="small" />}
          onClick={() => onEdit(row.original)}
          disabled={loading}
          opensModal
        />
        <MrtRowActionButton
          label="Видалити"
          icon={<DeleteIcon fontSize="small" />}
          onClick={() => onDelete(row.original)}
          disabled={loading}
          tone="danger"
          opensModal
        />
      </MrtRowActions>
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
      getDefaultMrtPaperProps({ table, loading, layout: 'workspace' }),
    muiTableContainerProps: ({ table }) =>
      getDefaultMrtContainerProps({
        loading,
        layout: 'workspace',
        fullScreen: table.getState().isFullScreen,
        hasRows: rows.length > 0,
      }),
    state: {
      showAlertBanner: false,
      showProgressBars: loading,
      globalFilter: tableStateContext.globalFilter,
      columnVisibility: tableStateContext.columnVisibility,
      columnFilters: tableStateContext.columnFilters,
      density: tableStateContext.density,
      sorting: tableStateContext.sorting,
      columnOrder: tableStateContext.columnOrder,
      columnSizing: tableStateContext.columnSizing,
    },
  });

  useEffect(() => tableStateContext.onTableInitialized(table), [table]);

  return <MaterialReactTable table={table} />;
}

function RerReportMetadataTableBody({
  rows,
  setRows,
  loading,
  disabled,
  onReload,
}: {
  rows: RerReportMetadataItem[];
  setRows: (rows: RerReportMetadataItem[]) => void;
  loading: boolean;
  disabled: boolean;
  onReload: () => void;
}) {
  const { notify } = usePowerSnackbar();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleting, setDeleting] = useState<RerReportMetadataItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openCreate() {
    setError(null);
    setEditor({ id: null, unit: null, locations: [], reportName: '' });
  }

  function openEdit(row: RerReportMetadataItem) {
    setError(null);
    setEditor({
      id: row.id,
      unit: {
        id: row.sigintUnitId,
        name: row.sigintUnitName,
        reportParentContext: row.sigintUnitDeleted ? undefined : row.reportParentContext,
      },
      locations: row.locations,
      reportName: row.reportName,
    });
  }

  async function save() {
    if (!editor?.unit) return;
    const locations = normalizeValues(editor.locations);
    const reportName = editor.reportName.trim();
    if (!reportName || /[\r\n]/.test(reportName)) {
      setError('Вкажіть непорожню назву для звіту одним рядком.');
      return;
    }
    if (
      editor.unit.reportParentContext &&
      editor.unit.reportParentContext !== '[]' &&
      rows.some(
        (row) =>
          !row.sigintUnitDeleted &&
          row.reportParentContext !== '[]' &&
          row.id !== editor.id &&
          row.reportName === reportName &&
          row.reportParentContext !== editor.unit?.reportParentContext,
      )
    ) {
      setError(
        `Назва для звіту «${reportName}» вже використовується підрозділом з іншою ієрархією. Оберіть іншу назву.`,
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved =
        editor.id === null
          ? await createRerReportMetadata({
              sigintUnitId: editor.unit.id,
              locations,
              reportName,
            })
          : await updateRerReportMetadata({
              id: editor.id,
              sigintUnitId: editor.unit.id,
              locations,
              reportName,
            });
      setRows(sortRows([...rows.filter((row) => row.id !== saved.id), saved]));
      setEditor(null);
      notify({ severity: 'success', message: 'Метадані РЕР збережено.' });
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setSaving(true);
    try {
      await deleteRerReportMetadata({ id: deleting.id });
      setRows(rows.filter((row) => row.id !== deleting.id));
      setDeleting(null);
      notify({ severity: 'success', message: 'Метадані РЕР видалено.' });
    } catch (nextError) {
      notify({ severity: 'error', message: errorMessage(nextError) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-echo-lg">
      <TablePageToolbar
        title="Метадані підрозділів для звіту РЕР"
        withGlobalTextFilter
        internalActionsDisabled={loading || disabled}
        actions={
          <>
            <PowerButton
              variant="contained"
              startIcon={<AddIcon />}
              onClick={openCreate}
              disabled={loading || disabled || saving}
            >
              Додати новий
            </PowerButton>
            <PowerButton
              variant="outlined"
              startIcon={<RefreshIcon />}
              onClick={onReload}
              disabled={loading || saving}
            >
              Оновити
            </PowerButton>
          </>
        }
      />
      <p className="text-echo-sm">
        Підрозділ і всі його підпорядковані підрозділи потрапляють до звіту. Однакова назва для
        звіту об’єднує їхні повідомлення в один розділ. Окремі налаштування дочірнього підрозділу
        мають пріоритет.
      </p>
      <div className="flex min-h-[320px] min-w-0 flex-1">
        <MetadataTable
          rows={rows}
          loading={loading || disabled || saving}
          onEdit={openEdit}
          onDelete={setDeleting}
        />
      </div>
      <MetadataEditor
        state={editor}
        rows={rows}
        saving={saving}
        error={error}
        onChange={setEditor}
        onClose={() => !saving && setEditor(null)}
        onSave={() => void save()}
      />
      <ConfirmDangerDialog
        open={deleting !== null}
        onClose={() => !saving && setDeleting(null)}
        onConfirm={() => void remove()}
        submitting={saving}
        title="Видалити метадані РЕР?"
        description={
          deleting ? `Метадані підрозділу «${deleting.sigintUnitName}» буде видалено.` : undefined
        }
      />
    </div>
  );
}

export function RerReportMetadataTable(props: {
  rows: RerReportMetadataItem[];
  setRows: (rows: RerReportMetadataItem[]) => void;
  loading: boolean;
  disabled: boolean;
  onReload: () => void;
}) {
  return (
    <TableStateProvider
      tableId="admin-rer-report-metadata"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMN_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <RerReportMetadataTableBody {...props} />
    </TableStateProvider>
  );
}
