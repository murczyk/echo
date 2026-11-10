import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import GridOnOutlinedIcon from '@mui/icons-material/GridOnOutlined';
import {
  CircularProgress,
  Divider,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  MaterialReactTable,
  type MRT_ColumnFiltersState,
  type MRT_RowSelectionState,
  type MRT_SortingState,
  type MRT_VisibilityState,
} from 'material-react-table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PowerAlert } from '../../../components/PowerAlert';
import { PowerChip } from '../../../components/PowerChip';
import { InternalTableActions } from '../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions';
import {
  CUSTOM_STYLES,
  FULL_HEIGHT_LOADING_ROW_COUNT,
  FULL_WIDTH_TABLE_PAPER_SX,
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../../components/mui-customized/table/custom-styles';
import {
  buildDefaultColumnOrder,
  getDefaultMRTOptions,
  mrtCustomCell,
  renderColumnActionsMenuItems,
  useAppMaterialReactTable,
  type AppMrtColumnDef,
} from '../../../components/mui-customized/table/get-default-table-options';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../../components/mui-customized/table/table-state-provider';
import { downloadBlob } from '../../../utils/download-blob';
import {
  buildContactsCsv,
  buildContactsXlsx,
  contactFullName,
  contactsFileName,
  withAccountRow,
  XLSX_MIME,
  type ContactRow,
} from '../messenger-contacts-export';
import { clearTableQueryInUrl } from '../helpers';
import { useMessengerContacts } from '../use-messenger-contacts';
import { CopyValue } from './CopyValue';
import type { MessengerAccountItem } from './MessengerAccountList';
import { MessengerSearchField } from './MessengerSearchField';

type Props = {
  account: MessengerAccountItem;
  refreshToken?: number;
  // Reports whether a request is running, for the header refresh button.
  onBusyChange?: (busy: boolean) => void;
  onBack: () => void;
};

type ExportFormat = 'csv' | 'xlsx';
type ExportScope = 'all' | 'selected';

// The next page is asked for this close to the end of the loaded rows.
const LOAD_MORE_THRESHOLD_PX = 600;
const NO_DATA = '—';
const defaultMrtOptions = getDefaultMRTOptions<ContactRow>();

const loadingRows = (): ContactRow[] =>
  Array.from({ length: FULL_HEIGHT_LOADING_ROW_COUNT }, (_, index) => ({
    id: `loading-${index}`,
    userId: null,
    username: null,
    firstName: null,
    lastName: null,
    phone: null,
  }));

const copyOrDash = (value: string | null, render: (text: string) => React.ReactNode) =>
  value ? (
    <CopyValue text={value}>{render(value)}</CopyValue>
  ) : (
    <Typography color="text.secondary">{NO_DATA}</Typography>
  );

const COLUMN_IDS = ['name', 'userId', 'username', 'phone'];
const DEFAULT_COLUMN_VISIBILITY: MRT_VisibilityState = Object.fromEntries(
  COLUMN_IDS.map((id) => [id, true]),
);
const DEFAULT_COLUMN_ORDER = buildDefaultColumnOrder({
  dataColumnIds: COLUMN_IDS,
  withRowSelection: true,
});
// The URL may carry the sorting and filters of another table, e.g. the summary table of the echo tab.
const sanitizeSorting = (sorting: MRT_SortingState) =>
  sorting.filter((item) => COLUMN_IDS.includes(item.id));
const sanitizeColumnFilters = (filters: MRT_ColumnFiltersState) =>
  filters.filter((item) => COLUMN_IDS.includes(item.id));

// Every value is text ('' when missing), so sorting and the "contains" filters never meet a null.
const columns: AppMrtColumnDef<ContactRow>[] = [
  {
    header: "Ім'я",
    id: 'name',
    accessorFn: contactFullName,
    filterFn: 'contains',
    size: 360,
    meta: { overflowMode: 'custom', overflowOwner: 'shared-text' },
    // Clicking the name selects the row, as in kontur.
    // A column's own props replace the table's, so the shared cell look (the borders) is carried over.
    muiTableBodyCellProps: ({ row }) => ({
      onClick: row.getToggleSelectedHandler(),
      sx: { ...CUSTOM_STYLES.muiTableBodyCellProps.sx, cursor: 'pointer' },
    }),
    Cell: mrtCustomCell(({ row }) => {
      const name = contactFullName(row.original);
      return name ? (
        <Typography fontWeight={600} noWrap>
          {name}
        </Typography>
      ) : (
        <Typography color="error" noWrap>
          Без імені
        </Typography>
      );
    }),
  },
  {
    header: 'User ID',
    id: 'userId',
    accessorFn: (row) => row.userId ?? '',
    filterFn: 'contains',
    // As in kontur the search looks at the name, the username and the phone.
    enableGlobalFilter: false,
    size: 160,
    meta: { overflowMode: 'custom', overflowOwner: 'shared-text' },
    Cell: mrtCustomCell(({ row }) =>
      copyOrDash(row.original.userId, (text) => (
        <Typography color="text.secondary" noWrap>
          {text}
        </Typography>
      )),
    ),
  },
  {
    header: 'Username',
    id: 'username',
    accessorFn: (row) => row.username ?? '',
    filterFn: 'contains',
    size: 260,
    meta: { overflowMode: 'custom', overflowOwner: 'shared-text' },
    Cell: mrtCustomCell(({ row }) =>
      row.original.username ? (
        <CopyValue text={`@${row.original.username}`}>
          <PowerChip label={`@${row.original.username}`} size="small" interactive={false} />
        </CopyValue>
      ) : (
        <Typography color="text.secondary">{NO_DATA}</Typography>
      ),
    ),
  },
  {
    header: 'Телефон',
    id: 'phone',
    accessorFn: (row) => row.phone ?? '',
    filterFn: 'contains',
    size: 200,
    meta: { overflowMode: 'custom', overflowOwner: 'shared-text' },
    Cell: mrtCustomCell(({ row }) =>
      copyOrDash(row.original.phone, (text) => <Typography noWrap>{text}</Typography>),
    ),
  },
];

const EXPORT_FORMATS: ReadonlyArray<{ format: ExportFormat; label: string }> = [
  { format: 'csv', label: 'CSV' },
  { format: 'xlsx', label: 'XLSX' },
];

// One export button for the toolbar, next to the table's own icon buttons: CSV or XLSX, everything or the selection.
function ExportMenu({
  allCount,
  selectedCount,
  busy,
  disabled,
  onExport,
}: {
  allCount: number;
  selectedCount: number;
  busy: boolean;
  disabled: boolean;
  onExport: (format: ExportFormat, scope: ExportScope) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const run = (format: ExportFormat, scope: ExportScope) => {
    setAnchor(null);
    onExport(format, scope);
  };
  return (
    <>
      <Tooltip title="Експорт">
        <span>
          <IconButton
            aria-label="Експорт контактів"
            aria-haspopup="menu"
            aria-expanded={anchor != null ? 'true' : undefined}
            disabled={disabled || busy}
            data-messenger-contacts-export
            onClick={(event) => setAnchor(event.currentTarget)}
          >
            {busy ? <CircularProgress size={20} color="inherit" /> : <FileDownloadOutlinedIcon />}
          </IconButton>
        </span>
      </Tooltip>
      <Menu anchorEl={anchor} open={anchor != null} onClose={() => setAnchor(null)}>
        {EXPORT_FORMATS.flatMap(({ format, label }, index) => [
          index > 0 ? <Divider key={`${format}-divider`} /> : null,
          <MenuItem key={`${format}-all`} onClick={() => run(format, 'all')}>
            <ListItemIcon>
              {format === 'csv' ? (
                <DescriptionOutlinedIcon fontSize="small" />
              ) : (
                <GridOnOutlinedIcon fontSize="small" />
              )}
            </ListItemIcon>
            {label}: усі ({allCount})
          </MenuItem>,
          <MenuItem
            key={`${format}-selected`}
            disabled={selectedCount === 0}
            onClick={() => run(format, 'selected')}
          >
            <ListItemIcon />
            {label}: вибрані ({selectedCount})
          </MenuItem>,
        ])}
      </Menu>
    </>
  );
}

// The address book of an analysis messenger account, as in kontur but with infinite scroll instead of pages:
// a virtualized table with sorting, filters and hideable columns like the other table pages, a search, row
// selection and CSV / XLSX export.
export function MessengerContactsView(props: Props) {
  return (
    <TableStateProvider
      tableId="rer-analysis-messenger-contacts"
      defaultColumnVisibility={DEFAULT_COLUMN_VISIBILITY}
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultEnableColumnOrdering={false}
      sanitizeSorting={sanitizeSorting}
      sanitizeColumnFilters={sanitizeColumnFilters}
    >
      <MessengerContactsViewBody {...props} />
    </TableStateProvider>
  );
}

function MessengerContactsViewBody({ account, refreshToken = 0, onBusyChange, onBack }: Props) {
  const tableStateContext = useTableStateContext();
  const contactsState = useMessengerContacts(account.id, refreshToken);
  const {
    contacts,
    total,
    loading,
    fetching,
    error,
    hasMore,
    loadMore,
    loadAll,
    fetchEveryContact,
    retry,
  } = contactsState;
  const [rowSelection, setRowSelection] = useState<MRT_RowSelectionState>({});
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [notice, setNotice] = useState<{ severity: 'error' | 'success'; text: string } | null>(
    null,
  );
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    onBusyChange?.(fetching);
    return () => onBusyChange?.(false);
  }, [fetching, onBusyChange]);

  const rows = useMemo(() => withAccountRow(contacts, account), [contacts, account]);
  // The account itself is not a contact of the list, so it is not in the total.
  const allCount = total + (rows.length - contacts.length);
  const selectedRows = useMemo(
    () => rows.filter((row) => rowSelection[row.id]),
    [rows, rowSelection],
  );

  // A search, a filter or a sorting has to see every contact, not only the pages that were scrolled to.
  const needsEveryContact =
    tableStateContext.globalFilter.trim() !== '' ||
    tableStateContext.columnFilters.length > 0 ||
    tableStateContext.sorting.length > 0;
  useEffect(() => {
    if (needsEveryContact && hasMore) void loadAll();
  }, [needsEveryContact, hasMore, loadAll]);

  // The table keeps its state in the URL; the echo tab must not inherit it when the contacts are left.
  useEffect(() => clearTableQueryInUrl, []);

  // After a failed page the retry also goes on with the rest when a search, a filter or a sorting needs every contact.
  const retryLoading = () => {
    retry();
    if (needsEveryContact) void loadAll();
  };

  const loadMoreWhenNearEnd = useCallback(() => {
    const element = containerRef.current;
    if (element == null || !hasMore || fetching) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight <= LOAD_MORE_THRESHOLD_PX) {
      loadMore();
    }
  }, [fetching, hasMore, loadMore]);
  // Rows that do not fill the table leave nothing to scroll, so the next page is asked for here.
  useEffect(loadMoreWhenNearEnd, [loadMoreWhenNearEnd, rows.length]);

  async function exportContacts(format: ExportFormat, scope: ExportScope) {
    setExporting(format);
    setNotice(null);
    try {
      let list: ContactRow[];
      if (scope === 'all') {
        // A fresh pass over every page, so a contact scrolled past long ago or moved by a sync is not missed.
        const all = await fetchEveryContact();
        if (all == null) {
          setNotice({
            severity: 'error',
            text: 'Не вдалося отримати повний список контактів для експорту. Спробуйте ще раз.',
          });
          return;
        }
        list = withAccountRow(all, account);
      } else {
        list = selectedRows;
      }
      if (list.length === 0) {
        setNotice({ severity: 'error', text: 'Немає даних для експорту.' });
        return;
      }
      if (format === 'csv') {
        downloadBlob(
          new Blob([buildContactsCsv(list)], { type: 'text/csv;charset=utf-8;' }),
          contactsFileName(account.id, 'csv'),
        );
      } else {
        downloadBlob(
          new Blob([buildContactsXlsx(list) as BlobPart], { type: XLSX_MIME }),
          contactsFileName(account.id, 'xlsx'),
        );
      }
      setNotice({ severity: 'success', text: 'Файл сформовано.' });
    } finally {
      setExporting(null);
    }
  }

  const showSkeleton = loading;
  const table = useAppMaterialReactTable({
    columns,
    data: showSkeleton ? loadingRows() : rows,
    enablePagination: false,
    enableBottomToolbar: false,
    enableTopToolbar: false,
    enableDensityToggle: false,
    enableColumnActions: true,
    enableColumnFilters: true,
    enableColumnFilterModes: false,
    enableFacetedValues: false,
    enableGlobalFilter: true,
    globalFilterFn: 'contains',
    enableHiding: true,
    enableSorting: true,
    enableRowSelection: !showSkeleton,
    enableMultiRowSelection: true,
    enableSelectAll: true,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    columnFilterDisplayMode: 'popover',
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onSortingChange: tableStateContext.onSortingChange,
    onRowSelectionChange: setRowSelection,
    defaultColumn: { renderColumnActionsMenuItems },
    localization: {
      ...defaultMrtOptions.localization,
      select: '',
      toggleSelectAll: 'Вибрати всі рядки',
      toggleSelectRow: 'Вибрати рядок',
    },
    muiTablePaperProps: ({ table: instance }) => {
      const paperProps = getDefaultMrtPaperProps({
        table: instance,
        loading: fetching,
        layout: 'workspace',
      });
      return {
        ...paperProps,
        sx: {
          ...((paperProps as { sx?: object }).sx ?? {}),
          ...FULL_WIDTH_TABLE_PAPER_SX,
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
          height: '100%',
          minHeight: 0,
        },
        style: { ...((paperProps as { style?: object }).style ?? {}), padding: 0 },
      };
    },
    muiTableContainerProps: ({ table: instance }) => {
      const containerProps = getDefaultMrtContainerProps({
        loading: showSkeleton,
        layout: 'workspace',
        fullScreen: instance.getState().isFullScreen,
        hasRows: rows.length > 0,
      });
      return {
        ...containerProps,
        ref: containerRef,
        onScroll: loadMoreWhenNearEnd,
        sx: {
          ...((containerProps as { sx?: object }).sx ?? {}),
          height: '100%',
          minHeight: 0,
          maxHeight: '100%',
          overflowX: 'auto',
          overflowY: 'auto',
          // Closes the last row. The shared container rule that removes the border of the last row has the same
          // specificity as a plain `:last-of-type`, so this one is made more specific to win.
          '& .MuiTableBody-root .MuiTableRow-root:last-child:last-of-type > .MuiTableCell-root': {
            borderBottom: '1px solid var(--bs-border-color)',
          },
        },
      };
    },
    muiTableBodyRowProps: { hover: true },
    state: {
      rowSelection,
      showAlertBanner: false,
      showLoadingOverlay: false,
      density: tableStateContext.density,
      columnVisibility: tableStateContext.columnVisibility,
      columnOrder: tableStateContext.columnOrder,
      columnSizing: tableStateContext.columnSizing,
      globalFilter: tableStateContext.globalFilter,
      columnFilters: tableStateContext.columnFilters,
      sorting: tableStateContext.sorting,
      isLoading: showSkeleton,
      showSkeletons: showSkeleton,
      // The next page is on its way under the loaded rows.
      showProgressBars: fetching && !showSkeleton,
    },
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table, tableStateContext]);

  const title = 'Контакти акаунту';
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      aria-label={title}
      data-messenger-contacts-view
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-solid border-black/12 px-2 py-1 dark:border-white/12">
        <IconButton size="small" aria-label="Назад до акаунта" onClick={onBack}>
          <ArrowBackIcon
            fontSize="small"
            className="group-data-[mobile=true]/messenger:!size-[18px]"
          />
        </IconButton>
        <h2 className="m-0 text-base font-medium group-data-[mobile=true]/messenger:!text-[18px] group-data-[mobile=true]/messenger:!font-medium">
          {title}
        </h2>
        <div className="ml-auto flex items-center gap-1">
          {/* The same search field as the other searches of the messenger, bound to the table's global filter. */}
          <div className="w-64 max-w-full [&_.MuiTextField-root]:w-full">
            <MessengerSearchField
              value={tableStateContext.globalFilter}
              onChange={tableStateContext.onChangeGlobalFilter}
              ariaLabel="Пошук контактів"
            />
          </div>
          <ExportMenu
            allCount={allCount}
            selectedCount={selectedRows.length}
            busy={exporting != null}
            disabled={loading || rows.length === 0}
            onExport={(format, scope) => void exportContacts(format, scope)}
          />
          <InternalTableActions table={tableStateContext.tableInstance} />
        </div>
      </header>
      {error != null ? (
        <div className="p-3">
          <PowerAlert
            severity="error"
            action={
              <button type="button" className="cursor-pointer underline" onClick={retryLoading}>
                Повторити завантаження
              </button>
            }
          >
            {error}
          </PowerAlert>
        </div>
      ) : null}
      {notice != null ? (
        <div className="p-3">
          <PowerAlert severity={notice.severity} onClose={() => setNotice(null)}>
            {notice.text}
          </PowerAlert>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <MaterialReactTable table={table} />
      </div>
    </section>
  );
}
