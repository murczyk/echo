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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

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
import { useObservedWidth } from '../../../hooks/use-observed-width';
import { downloadBlob } from '../../../utils/download-blob';
import {
  buildContactsCsv,
  buildContactsXlsx,
  contactFullName,
  XLSX_MIME,
  type ContactRow,
} from '../messenger-contacts-export';
import { clearTableQueryInUrl } from '../helpers';
import { CopyValue } from './CopyValue';
import { MessengerSearchField } from './MessengerSearchField';

type Props = {
  // Hosted in a side panel: flat on the panel's own background instead of white, and the search on the left.
  panel?: boolean;
  // Keys the table state (hidden columns, URL params), one per kind of list.
  tableId: string;
  // Names the section for assistive tech and the search and export buttons.
  title: string;
  searchLabel: string;
  exportLabel: string;
  // Before the search, e.g. the back arrow and the title of a page.
  leading?: ReactNode;
  // Extra attributes of the section, e.g. a `data-` marker for the page that hosts the table.
  rootAttributes?: Record<`data-${string}`, string>;
  rows: ContactRow[];
  // Every row of the list, which may be more than `rows` while pages are still arriving.
  allCount: number;
  loading: boolean;
  fetching: boolean;
  error: string | null;
  hasMore?: boolean;
  loadMore?: () => void;
  // Brings the rest of the pages, for a search, a filter or a sorting over the whole list.
  loadAll?: () => void;
  retry: () => void;
  // Every row for "export all" from a fresh request; null when it failed. Without it the loaded rows are exported.
  fetchAllRows?: () => Promise<ContactRow[] | null>;
  fileName: (extension: 'csv' | 'xlsx') => string;
  // Reports whether a request is running, for the header refresh button.
  onBusyChange?: (busy: boolean) => void;
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

// Below this width of the table itself (the minimum widths of the columns add up to about 586 px) it goes dense: smaller
// text, 3 px cells, and `DENSE_COLUMNS` instead of the sizes of the columns. The fixed ones are cut to their content at
// 0.7rem = 11.2 px (about 5.4 px a digit: 5.8 px at 12 px, measured off a screenshot) plus the 3 px cell padding and the border: a Telegram user id is
// 10 digits, a phone is "+", 11 digits and 2 spare characters (14). The name and the username share the rest equally above
// their minimums.
const DENSE_BELOW_PX = 560;
const DENSE_CHECKBOX_COLUMN_PX = 22;
const DENSE_COLUMNS: Record<string, { size: number; grow: boolean }> = {
  name: { size: 62, grow: true },
  userId: { size: 68, grow: false },
  username: { size: 84, grow: true },
  phone: { size: 84, grow: false },
};

// Widths are tight so that all four columns fit a narrow host (the right panel): User ID and phone are fixed (the phone
// fits "+" and a Russian number with 2 spare characters), the name and the username share the rest equally, never below
// their `size`.
// Every value is text ('' when missing), so sorting and the "contains" filters never meet a null.
const columns: AppMrtColumnDef<ContactRow>[] = [
  {
    header: "Ім'я",
    id: 'name',
    accessorFn: contactFullName,
    filterFn: 'contains',
    size: 130,
    grow: true,
    meta: { overflowMode: 'custom', overflowOwner: 'shared-text' },
    // Clicking the name selects the row, as in kontur.
    // A column's own props replace the table's, so the shared cell look (the borders) is carried over.
    muiTableBodyCellProps: ({ row }) => ({
      onClick: row.getToggleSelectedHandler(),
      sx: { ...CUSTOM_STYLES.muiTableBodyCellProps.sx, cursor: 'pointer' },
    }),
    Cell: mrtCustomCell(({ row }) => {
      const name = contactFullName(row.original);
      const deletedMark = row.original.deleted ? (
        <Typography component="span" color="text.secondary" fontWeight={400}>
          {' (видалено)'}
        </Typography>
      ) : null;
      return name ? (
        <Typography fontWeight={600} noWrap>
          {name}
          {deletedMark}
        </Typography>
      ) : (
        <Typography color="error" noWrap>
          Без імені
          {deletedMark}
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
    size: 118,
    grow: false,
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
    size: 160,
    grow: true,
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
    size: 150,
    grow: false,
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
  label,
  allCount,
  selectedCount,
  busy,
  disabled,
  onExport,
}: {
  label: string;
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
            aria-label={label}
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

// A list of people of an analysis messenger account (its contacts, or the members of a chat), as in kontur but with
// infinite scroll instead of pages: a virtualized table with sorting, filters and hideable columns like the other
// table pages, a search, row selection and CSV / XLSX export. The host loads the rows.
export function MessengerPeopleTable(props: Props) {
  return (
    <TableStateProvider
      tableId={props.tableId}
      defaultColumnVisibility={DEFAULT_COLUMN_VISIBILITY}
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultEnableColumnOrdering={false}
      sanitizeSorting={sanitizeSorting}
      sanitizeColumnFilters={sanitizeColumnFilters}
    >
      <MessengerPeopleTableBody {...props} />
    </TableStateProvider>
  );
}

function MessengerPeopleTableBody({
  title,
  searchLabel,
  exportLabel,
  panel = false,
  leading,
  rootAttributes,
  rows,
  allCount,
  loading,
  fetching,
  error,
  hasMore = false,
  loadMore,
  loadAll,
  retry,
  fetchAllRows,
  fileName,
  onBusyChange,
}: Props) {
  const tableStateContext = useTableStateContext();
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

  const selectedRows = useMemo(
    () => rows.filter((row) => rowSelection[row.id]),
    [rows, rowSelection],
  );

  // A search, a filter or a sorting has to see every row, not only the pages that were scrolled to.
  const needsEveryContact =
    tableStateContext.globalFilter.trim() !== '' ||
    tableStateContext.columnFilters.length > 0 ||
    tableStateContext.sorting.length > 0;
  useEffect(() => {
    if (needsEveryContact && hasMore) loadAll?.();
  }, [needsEveryContact, hasMore, loadAll]);

  // The table keeps its state in the URL; the echo tab must not inherit it when the list is left.
  useEffect(() => clearTableQueryInUrl, []);

  // After a failed page the retry also goes on with the rest when a search, a filter or a sorting needs every row.
  const retryLoading = () => {
    retry();
    if (needsEveryContact) loadAll?.();
  };

  const loadMoreWhenNearEnd = useCallback(() => {
    const element = containerRef.current;
    if (element == null || !hasMore || fetching) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight <= LOAD_MORE_THRESHOLD_PX) {
      loadMore?.();
    }
  }, [fetching, hasMore, loadMore]);
  // Rows that do not fill the table leave nothing to scroll, so the next page is asked for here.
  useEffect(loadMoreWhenNearEnd, [loadMoreWhenNearEnd, rows.length]);

  async function exportRows(format: ExportFormat, scope: ExportScope) {
    setExporting(format);
    setNotice(null);
    try {
      let list: ContactRow[];
      if (scope === 'all') {
        // A fresh pass over every page, so a row scrolled past long ago or moved by a sync is not missed.
        const all = fetchAllRows == null ? rows : await fetchAllRows();
        if (all == null) {
          setNotice({
            severity: 'error',
            text: 'Не вдалося отримати повний список для експорту. Спробуйте ще раз.',
          });
          return;
        }
        list = all;
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
          fileName('csv'),
        );
      } else {
        downloadBlob(
          new Blob([buildContactsXlsx(list) as BlobPart], { type: XLSX_MIME }),
          fileName('xlsx'),
        );
      }
      setNotice({ severity: 'success', text: 'Файл сформовано.' });
    } finally {
      setExporting(null);
    }
  }

  const showSkeleton = loading;
  const { ref: sectionRef, width } = useObservedWidth<HTMLElement>();
  const dense = width != null && width < DENSE_BELOW_PX;
  const tableColumns = useMemo(
    () =>
      dense ? columns.map((column) => ({ ...column, ...DENSE_COLUMNS[column.id!] })) : columns,
    [dense],
  );
  const table = useAppMaterialReactTable({
    columns: tableColumns,
    // The shared checkbox column is 54 px wide, more than a narrow host can spare: a small checkbox (20 px icon, 2 px
    // padding, see the container below) in a column of 28 px, with no padding in its cells.
    displayColumnDefOptions: {
      'mrt-row-select': {
        size: dense ? DENSE_CHECKBOX_COLUMN_PX : 28,
        minSize: dense ? DENSE_CHECKBOX_COLUMN_PX : 28,
        maxSize: dense ? DENSE_CHECKBOX_COLUMN_PX : 28,
        muiTableBodyCellProps: { sx: { padding: 0 } },
      },
    },
    data: showSkeleton ? loadingRows() : rows,
    enablePagination: false,
    enableBottomToolbar: false,
    enableTopToolbar: false,
    enableDensityToggle: false,
    // Dense: no column menus and no resize handles, they take more room than a phone has.
    enableColumnActions: !dense,
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
    enableColumnResizing: !dense && tableStateContext.enableColumnResizing,
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
          // The cells are transparent, so the paper is the white that shows; in a panel the panel's background shows instead.
          ...(panel && { backgroundColor: 'transparent', backgroundImage: 'none' }),
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
          '& .MuiCheckbox-root': { padding: '2px' },
          '& .MuiCheckbox-root .MuiSvgIcon-root': { fontSize: 20 },
          // Dense: 3 px cells, a smaller header, the username tile with 2 px inside, the smallest checkbox.
          ...(dense && {
            '& .MuiTableCell-root': {
              paddingLeft: '3px',
              paddingRight: '3px',
              fontSize: '0.7rem',
            },
            '& .MuiTableCell-root .MuiTypography-root': { fontSize: 'inherit' },
            '& .MuiTableCell-head': {
              minHeight: 0,
              paddingTop: '3px',
              paddingBottom: '3px',
              fontSize: '0.65rem',
            },
            // The sort and filter icons of the header: MRT gives their wrappers fixed sizes and margins (the filter span is
            // 20 x 24, the sort label a few `ch` wide), so the wrappers are cut down along with the icons, which leaves
            // the header text its room (the "User ID" header was cut to "Us…").
            '& .Mui-TableHeadCell-Content-Labels': { gap: 0, minWidth: 0 },
            '& .Mui-TableHeadCell-Content-Wrapper': { whiteSpace: 'normal', lineHeight: 1.1 },
            '& .Mui-TableHeadCell-Content-Labels > span.MuiBox-root, & .Mui-TableHeadCell-Content-Labels > .MuiBadge-root':
              { width: 'auto', height: 'auto', margin: 0, display: 'inline-flex' },
            '& .MuiTableCell-head .MuiSvgIcon-root': { fontSize: 17 },
            '& .MuiTableCell-head .MuiIconButton-root': { padding: 0, margin: 0 },
            '& .MuiTableCell-head .MuiTableSortLabel-root': { width: 'auto', margin: 0 },
            '& .MuiTableCell-head .MuiTableSortLabel-icon': { margin: 0 },
            '& .MuiChip-root': { height: 16, fontSize: '0.65rem' },
            '& .MuiChip-label': { paddingLeft: '2px', paddingRight: '2px' },
            // The checkbox cells keep no padding (the rules above match them too), and the checkbox is an icon button, so its
            // size and padding are put back after the header icon rules; more specific, so they win in the header too.
            '& .MuiTableCell-root:has(.MuiCheckbox-root)': { padding: 0 },
            '& .MuiTableCell-root .MuiCheckbox-root': { padding: '1px' },
            '& .MuiTableCell-root .MuiCheckbox-root .MuiSvgIcon-root': { fontSize: 16 },
          }),
          // Closes the last row. The shared container rule that removes the border of the last row has the same
          // specificity as a plain `:last-of-type`, so this one is made more specific to win.
          '& .MuiTableBody-root .MuiTableRow-root:last-child:last-of-type > .MuiTableCell-root': {
            borderBottom: '1px solid var(--bs-border-color)',
          },
        },
      };
    },
    // MRT paints every body row with the theme's background (white); in a panel the rows are left transparent.
    muiTableBodyRowProps: { hover: true, ...(panel && { sx: { backgroundColor: 'transparent' } }) },
    state: {
      rowSelection,
      showAlertBanner: false,
      showLoadingOverlay: false,
      density: tableStateContext.density,
      columnVisibility: tableStateContext.columnVisibility,
      columnOrder: tableStateContext.columnOrder,
      // A size dragged on a wide screen is not meant for a phone.
      columnSizing: dense ? {} : tableStateContext.columnSizing,
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

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      ref={sectionRef}
      aria-label={title}
      // The shared table styles paint the table with the body background; in a panel that is the panel's.
      style={
        panel
          ? ({
              '--bs-body-bg': 'var(--analysis-panel-background, var(--echo-color-background))',
            } as CSSProperties)
          : undefined
      }
      {...rootAttributes}
    >
      <header
        className={
          'flex flex-wrap items-center border-b border-solid border-black/12 py-1 dark:border-white/12' +
          // Dense: tighter, and the icon buttons of the toolbar lose most of their padding (`!`: MUI's styles are outside the
          // cascade layers and beat a plain utility).
          (dense ? ' gap-1 px-1 [&_.MuiIconButton-root]:!p-1' : ' gap-2 px-2')
        }
      >
        {leading}
        {/* `contents` wrappers: on a page the search and the tools sit in one group on the right, in a panel the search is
            on the left and the tools on the right. A dense page puts the group on a line of its own, search stretched. */}
        <div
          className={
            panel
              ? 'contents'
              : dense
                ? 'flex min-w-0 basis-full items-center gap-0.5'
                : 'ml-auto flex items-center gap-1'
          }
        >
          {/* The same search field as the other searches of the messenger, bound to the table's global filter. */}
          <div
            className={
              (panel
                ? 'min-w-0 max-w-sm flex-1 basis-40'
                : dense
                  ? 'min-w-0 flex-1'
                  : 'w-64 max-w-full') + ' [&_.MuiTextField-root]:w-full'
            }
          >
            <MessengerSearchField
              value={tableStateContext.globalFilter}
              onChange={tableStateContext.onChangeGlobalFilter}
              ariaLabel={searchLabel}
            />
          </div>
          <div
            className={
              panel
                ? dense
                  ? 'ml-auto flex items-center'
                  : 'ml-auto flex items-center gap-1'
                : 'contents'
            }
          >
            <ExportMenu
              label={exportLabel}
              allCount={allCount}
              selectedCount={selectedRows.length}
              busy={exporting != null}
              disabled={loading || rows.length === 0}
              onExport={(format, scope) => void exportRows(format, scope)}
            />
            <InternalTableActions table={tableStateContext.tableInstance} />
          </div>
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
