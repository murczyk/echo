import AddIcon from '@mui/icons-material/Add';
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
import { MaterialReactTable } from 'material-react-table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  CreateUnitWithAutoNetworkRsp,
  OrbitUnitLinkCandidate,
  Unit,
} from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import {
  CUSTOM_STYLES,
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../components/mui-customized/table/custom-styles';
import {
  type AppMrtColumnDef,
  getDefaultMRTOptions,
  mrtTextCell,
  useAppMaterialReactTable,
  getFilterModeHelperText,
  getSharedFilterTextFieldProps,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import { HttpRequestError, isAbortError } from '../../services/api/client';
import {
  getOrbitUnitLinkCandidates,
  importOrbitUnit,
  linkOrbitUnit,
  searchOrbitUnits,
} from '../../services/api/units';

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

function useOrbitUnitColumns({
  importing,
  loading,
  processingUnitId,
  onAction,
}: {
  importing: boolean;
  loading: boolean;
  processingUnitId: string | null;
  onAction: (unit: OrbitUnitLinkCandidate) => void;
}): AppMrtColumnDef<OrbitUnitLinkCandidate>[] {
  return useMemo(
    () => [
      {
        header: 'Повна назва',
        accessorKey: 'fullName',
        size: 280,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => renderTextValue(cell.getValue()),
          fullValue: ({ cell }) => renderTextValue(cell.getValue()),
        }),
      },
      {
        header: 'Приналежність',
        accessorKey: 'generativeUnitNameFull',
        size: 320,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => renderTextValue(cell.getValue()),
          fullValue: ({ cell }) => renderTextValue(cell.getValue()),
        }),
      },
      {
        header: 'Підпорядкування',
        accessorKey: 'operationalUnitNameFull',
        size: 320,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => renderTextValue(cell.getValue()),
          fullValue: ({ cell }) => renderTextValue(cell.getValue()),
        }),
      },
      {
        header: 'ID',
        accessorKey: 'unitId',
        size: 280,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => renderTextValue(cell.getValue()),
          fullValue: ({ cell }) => renderTextValue(cell.getValue()),
          displaySx: { fontFamily: 'monospace', fontSize: '0.8rem' },
        }),
      },
      {
        header: '',
        id: 'link',
        size: 150,
        enableColumnActions: false,
        enableColumnFilter: false,
        enableSorting: false,
        meta: { overflowMode: 'none' },
        Cell: ({ row }) => (
          <Button
            size="small"
            variant="contained"
            startIcon={importing ? <AddIcon fontSize="small" /> : <LinkIcon fontSize="small" />}
            disabled={loading || processingUnitId !== null}
            onClick={() => onAction(row.original)}
            sx={{ textTransform: 'none', whiteSpace: 'nowrap' }}
          >
            {importing ? 'Імпортувати' : "Прив'язати"}
          </Button>
        ),
      },
    ],
    [importing, loading, onAction, processingUnitId],
  );
}

type OrbitUnitDialogProps =
  | {
      mode: 'link';
      unitId: number;
      unit: Unit;
      onClose: () => void;
      onCompleted: () => void;
    }
  | {
      mode: 'import';
      onClose: () => void;
      onCompleted: (response: CreateUnitWithAutoNetworkRsp) => void;
    }
  | {
      mode: 'select';
      title: string;
      searchUnits: (
        req: { search: string },
        options?: { signal?: AbortSignal },
      ) => Promise<OrbitUnitLinkCandidate[]>;
      onClose: () => void;
      onCompleted: (unit: OrbitUnitLinkCandidate) => void;
    };

function sigintUnitDescription(unit: Unit): string {
  const hierarchySegments = [
    unit.other,
    unit.teamOrCrew,
    unit.section,
    unit.squad,
    unit.platoon,
    unit.company,
    unit.battalion,
    unit.regiment,
    unit.brigade,
    unit.division,
    unit.corps,
    unit.army,
    unit.militaryDistrict,
    unit.armyRegion,
  ]
    .map((segment) => segment.trim())
    .filter(Boolean);
  const hierarchy = hierarchySegments.join(' ');
  const name = unit.name.trim();
  const normalizedName = ` ${name.toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ')} `;
  const unitValue = hierarchySegments[0]?.toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ');
  const repeatsUnitValue = unitValue ? normalizedName.includes(` ${unitValue} `) : false;
  return [name, hierarchy && !repeatsUnitValue ? `(${hierarchy})` : ''].filter(Boolean).join(' ');
}

function OrbitUnitDialogBody(props: OrbitUnitDialogProps) {
  const { onClose } = props;
  const importing = props.mode === 'import';
  const unitId = props.mode === 'link' ? props.unitId : null;
  const selectionSearchUnits = props.mode === 'select' ? props.searchUnits : null;
  const tableStateContext = useTableStateContext();
  const [advancedSearch, setAdvancedSearch] = useState(props.mode !== 'link');
  const [search, setSearch] = useState('');
  const [units, setUnits] = useState<OrbitUnitLinkCandidate[]>([]);
  const [loading, setLoading] = useState(!importing);
  const [error, setError] = useState<string | null>(null);
  const [processingUnitId, setProcessingUnitId] = useState<string | null>(null);
  const automaticRequestControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (unitId === null) return;
    const linkUnitId = unitId;
    const controller = new AbortController();
    automaticRequestControllerRef.current = controller;

    async function loadAutomaticCandidates() {
      setLoading(true);
      setError(null);
      try {
        const nextUnits = await getOrbitUnitLinkCandidates(
          { unitId: linkUnitId, search: null },
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
        const nextUnits =
          selectionSearchUnits !== null
            ? await selectionSearchUnits({ search: trimmedSearch }, { signal: controller.signal })
            : unitId === null
              ? await searchOrbitUnits({ search: trimmedSearch }, { signal: controller.signal })
              : await getOrbitUnitLinkCandidates(
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
  }, [advancedSearch, search, selectionSearchUnits, unitId]);

  const handleAction = useCallback(
    async (unit: OrbitUnitLinkCandidate) => {
      setProcessingUnitId(unit.unitId);
      setError(null);
      try {
        if (props.mode === 'select') {
          props.onCompleted(unit);
        } else if (props.mode === 'import') {
          const response = await importOrbitUnit({ orbitUnitId: unit.unitId });
          props.onCompleted(response);
        } else {
          await linkOrbitUnit({ sigintUnitId: props.unitId, orbitUnitId: unit.unitId });
          props.onCompleted();
        }
      } catch (error) {
        setError(formatError(error));
      } finally {
        setProcessingUnitId(null);
      }
    },
    [props],
  );

  const columns = useOrbitUnitColumns({
    importing,
    loading,
    processingUnitId,
    onAction: handleAction,
  });
  const table = useAppMaterialReactTable({
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
      onClose={processingUnitId === null ? onClose : undefined}
      PaperProps={{ sx: { height: 'min(760px, calc(100vh - 64px))' } }}
    >
      <DialogTitle sx={{ pr: 7 }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Box component="img" src="/img/delta-icon.webp" alt="" sx={{ width: 28, height: 28 }} />
          <Typography component="span" variant="h6">
            {importing
              ? 'Пошук'
              : props.mode === 'select'
                ? props.title
                : `Прив'язати Orbit підрозділ ${sigintUnitDescription(props.unit)}`}
          </Typography>
        </Stack>
        <IconButton
          aria-label="Закрити"
          onClick={onClose}
          disabled={processingUnitId !== null}
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
            placeholder="Повна назва, приналежність або підпорядкування"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            disabled={processingUnitId !== null}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
        ) : null}

        {advancedSearch && !search.trim() ? (
          <Typography variant="body2" color="text.secondary">
            Введіть слова для пошуку підрозділу.
          </Typography>
        ) : null}

        <Box sx={{ flex: 1, minHeight: 0 }}>
          <MaterialReactTable table={table} />
        </Box>

        {!advancedSearch ? (
          <>
            <PowerAlert severity="info">
              Якщо жоден варіант не підійшов - спробуйте розширений пошук
            </PowerAlert>
            <Box>
              <Button variant="outlined" startIcon={<SearchIcon />} onClick={startAdvancedSearch}>
                Розширений пошук
              </Button>
            </Box>
          </>
        ) : null}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} disabled={processingUnitId !== null}>
          Закрити
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function OrbitUnitDialog({
  tableId,
  ...props
}: OrbitUnitDialogProps & {
  tableId: string;
}) {
  return (
    <TableStateProvider
      tableId={tableId}
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMN_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <OrbitUnitDialogBody {...props} />
    </TableStateProvider>
  );
}

export function OrbitUnitLinkDialog({
  unitId,
  unit,
  onClose,
  onLinked,
}: {
  unitId: number;
  unit: Unit;
  onClose: () => void;
  onLinked: () => void;
}) {
  return (
    <OrbitUnitDialog
      mode="link"
      tableId="orbit-unit-link-candidates"
      unitId={unitId}
      unit={unit}
      onClose={onClose}
      onCompleted={onLinked}
    />
  );
}

export function OrbitUnitImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (response: CreateUnitWithAutoNetworkRsp) => void;
}) {
  return (
    <OrbitUnitDialog
      mode="import"
      tableId="orbit-unit-import-candidates"
      onClose={onClose}
      onCompleted={onImported}
    />
  );
}

export function OrbitUnitPickerDialog({
  title,
  searchUnits,
  onClose,
  onSelected,
}: {
  title: string;
  searchUnits: (
    req: { search: string },
    options?: { signal?: AbortSignal },
  ) => Promise<OrbitUnitLinkCandidate[]>;
  onClose: () => void;
  onSelected: (unit: OrbitUnitLinkCandidate) => void;
}) {
  return (
    <OrbitUnitDialog
      mode="select"
      tableId="unresolved-unit-orbit-candidates"
      title={title}
      searchUnits={searchUnits}
      onClose={onClose}
      onCompleted={onSelected}
    />
  );
}
