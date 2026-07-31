import CloseIcon from '@mui/icons-material/Close';
import LinkIcon from '@mui/icons-material/Link';
import SearchIcon from '@mui/icons-material/Search';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  type MRT_ColumnDef,
  MaterialReactTable,
  useMaterialReactTable,
} from 'material-react-table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { OrbitUnitLinkCandidate } from '../../../../Bindings';
import {
  CUSTOM_STYLES,
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../components/mui-customized/table/custom-styles';
import {
  getDefaultMRTOptions,
  getFilterModeHelperText,
  getSharedFilterTextFieldProps,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import { HttpRequestError, isAbortError } from '../../services/api/client';
import { getOrbitUnitLinkCandidates, linkOrbitUnit } from '../../services/api/units';

const defaultMrtOptions = getDefaultMRTOptions<OrbitUnitLinkCandidate>();
const SEARCH_DEBOUNCE_MS = 300;

const DEFAULT_COLUMN_ORDER = [
  'fullName',
  'generativeUnitNameFull',
  'operationalUnitNameFull',
  'unitId',
  'link',
];

const DEFAULT_COLUMN_VISIBILITY = {
  fullName: true,
  generativeUnitNameFull: true,
  operationalUnitNameFull: true,
  unitId: true,
  link: true,
};

function formatError(error: unknown): string {
  if (error instanceof HttpRequestError && error.message.trim()) return error.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Помилка запиту до сервера.';
}

function renderTextValue(value: unknown) {
  const text = String(value ?? '').trim();
  return text || '—';
}

function useOrbitUnitLinkColumns({
  loading,
  linkingUnitId,
  onLink,
}: {
  loading: boolean;
  linkingUnitId: string | null;
  onLink: (unit: OrbitUnitLinkCandidate) => void;
}): MRT_ColumnDef<OrbitUnitLinkCandidate>[] {
  return useMemo(
    () => [
      {
        header: 'Повна назва',
        accessorKey: 'fullName',
        size: 280,
        Cell: ({ cell }) => (
          <Box sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {renderTextValue(cell.getValue())}
          </Box>
        ),
      },
      {
        header: 'Ген. назва',
        accessorKey: 'generativeUnitNameFull',
        size: 320,
        Cell: ({ cell }) => (
          <Box sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {renderTextValue(cell.getValue())}
          </Box>
        ),
      },
      {
        header: 'Опер. назва',
        accessorKey: 'operationalUnitNameFull',
        size: 320,
        Cell: ({ cell }) => (
          <Box sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {renderTextValue(cell.getValue())}
          </Box>
        ),
      },
      {
        header: 'UUID',
        accessorKey: 'unitId',
        size: 280,
        Cell: ({ cell }) => (
          <Box
            component="span"
            sx={{
              fontFamily: 'monospace',
              fontSize: '0.8rem',
              overflowWrap: 'anywhere',
            }}
          >
            {renderTextValue(cell.getValue())}
          </Box>
        ),
      },
      {
        header: '',
        id: 'link',
        size: 150,
        enableColumnActions: false,
        enableColumnFilter: false,
        enableSorting: false,
        Cell: ({ row }) => (
          <Button
            size="small"
            variant="contained"
            startIcon={<LinkIcon fontSize="small" />}
            disabled={loading || linkingUnitId !== null}
            onClick={() => onLink(row.original)}
            sx={{ textTransform: 'none', whiteSpace: 'nowrap' }}
          >
            Прив'язати
          </Button>
        ),
      },
    ],
    [linkingUnitId, loading, onLink],
  );
}

function OrbitUnitLinkDialogBody({
  unitId,
  onClose,
  onLinked,
}: {
  unitId: number;
  onClose: () => void;
  onLinked: () => void;
}) {
  const tableStateContext = useTableStateContext();
  const [advancedSearch, setAdvancedSearch] = useState(false);
  const [search, setSearch] = useState('');
  const [units, setUnits] = useState<OrbitUnitLinkCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkingUnitId, setLinkingUnitId] = useState<string | null>(null);
  const automaticRequestControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    automaticRequestControllerRef.current = controller;

    async function loadAutomaticCandidates() {
      setLoading(true);
      setError(null);
      try {
        const nextUnits = await getOrbitUnitLinkCandidates(
          { unitId, search: null },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setUnits(nextUnits);
        setAdvancedSearch(nextUnits.length === 0);
      } catch (error) {
        if (!isAbortError(error)) setError(formatError(error));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
        if (automaticRequestControllerRef.current === controller) {
          automaticRequestControllerRef.current = null;
        }
      }
    }

    loadAutomaticCandidates();
    return () => {
      controller.abort();
      if (automaticRequestControllerRef.current === controller) {
        automaticRequestControllerRef.current = null;
      }
    };
  }, [unitId]);

  useEffect(() => {
    if (!advancedSearch) return;

    const trimmedSearch = search.trim();
    if (!trimmedSearch) {
      setUnits([]);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const nextUnits = await getOrbitUnitLinkCandidates(
          { unitId, search: trimmedSearch },
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) setUnits(nextUnits);
      } catch (error) {
        if (!isAbortError(error)) setError(formatError(error));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [advancedSearch, search, unitId]);

  const handleLink = useCallback(
    async (unit: OrbitUnitLinkCandidate) => {
      setLinkingUnitId(unit.unitId);
      setError(null);
      try {
        await linkOrbitUnit({ sigintUnitId: unitId, orbitUnitId: unit.unitId });
        onLinked();
      } catch (error) {
        setError(formatError(error));
      } finally {
        setLinkingUnitId(null);
      }
    },
    [onLinked, unitId],
  );

  const columns = useOrbitUnitLinkColumns({ loading, linkingUnitId, onLink: handleLink });
  const table = useMaterialReactTable({
    ...defaultMrtOptions,
    columns,
    data: units,
    enableSorting: true,
    enableColumnActions: true,
    enableGlobalFilter: false,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    enableFacetedValues: true,
    columnFilterDisplayMode: 'popover',
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onSortingChange: tableStateContext.onSortingChange,
    muiFilterTextFieldProps: ({ column }) => ({
      ...getSharedFilterTextFieldProps(column.columnDef.filterVariant),
      helperText: getFilterModeHelperText(column.columnDef.filterVariant),
    }),
    defaultColumn: {
      size: 220,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: CUSTOM_STYLES.displayColumnDefOptions,
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

  function startAdvancedSearch() {
    automaticRequestControllerRef.current?.abort();
    automaticRequestControllerRef.current = null;
    setAdvancedSearch(true);
    setSearch('');
    setUnits([]);
    setError(null);
  }

  return (
    <Dialog
      open
      fullWidth
      maxWidth="xl"
      onClose={onClose}
      PaperProps={{ sx: { height: 'min(760px, calc(100vh - 64px))' } }}
    >
      <DialogTitle sx={{ pr: 7 }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Box component="img" src="/img/delta-icon.webp" alt="" sx={{ width: 28, height: 28 }} />
          <Typography component="span" variant="h6">
            Прив'язати Orbit підрозділ
          </Typography>
        </Stack>
        <IconButton
          aria-label="Закрити"
          onClick={onClose}
          sx={{ position: 'absolute', right: 12, top: 12 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ display: 'flex', minHeight: 0, flexDirection: 'column', gap: 2 }}>
        {error ? <Alert severity="error">{error}</Alert> : null}

        {advancedSearch ? (
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="Пошук"
            placeholder="Повна, ген. або опер. назва"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
        ) : (
          <Box>
            <Button variant="outlined" startIcon={<SearchIcon />} onClick={startAdvancedSearch}>
              Нема збігів, спробувати розширений пошук...
            </Button>
          </Box>
        )}

        {advancedSearch && !search.trim() ? (
          <Typography variant="body2" color="text.secondary">
            Введіть слова для пошуку підрозділу.
          </Typography>
        ) : null}

        <Box sx={{ flex: 1, minHeight: 0 }}>
          <MaterialReactTable table={table} />
        </Box>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Закрити</Button>
      </DialogActions>
    </Dialog>
  );
}

export function OrbitUnitLinkDialog(props: {
  unitId: number;
  onClose: () => void;
  onLinked: () => void;
}) {
  return (
    <TableStateProvider
      tableId="orbit-unit-link-candidates"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMN_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <OrbitUnitLinkDialogBody {...props} />
    </TableStateProvider>
  );
}
