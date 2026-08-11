import BlockIcon from '@mui/icons-material/Block';
import LinkIcon from '@mui/icons-material/Link';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Pagination,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import type { MRT_ColumnDef } from 'material-react-table';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { OrbitUnitLinkCandidate, UnresolvedUnitLabel } from '../../../../Bindings';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import { PowerAlert } from '../../components/PowerAlert';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import { HttpRequestError } from '../../services/api/client';
import {
  classifyUnresolvedUnitLabel,
  listUnresolvedUnitLabels,
  resolveUnresolvedUnitLabel,
  searchUnresolvedUnitOrbitUnits,
} from '../../services/api/unresolved-unit-labels';
import { hasRole } from '../../utils/roles';
import { OrbitUnitPickerDialog } from '../rer-unit-details/OrbitUnitLinkDialog';
import { SettingsNeoTable } from '../settings-neo/SettingsNeoTable';

const DEFAULT_COLUMN_ORDER = ['mrt-row-numbers', 'unitTxt', 'quantity', 'mrt-row-actions'];
const DEFAULT_COLUMN_VISIBILITY = {
  unitTxt: true,
  quantity: true,
  'mrt-row-actions': true,
};

function formatError(error: unknown): string {
  if (error instanceof HttpRequestError && error.message.trim()) return error.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Помилка запиту до сервера.';
}

type ResolveState = {
  row: UnresolvedUnitLabel;
  label: string;
  orbitUnit: OrbitUnitLinkCandidate | null;
};

export function AdminUnitUnparsedPage({ authUserRoles }: { authUserRoles: string[] }) {
  const [rows, setRows] = useState<UnresolvedUnitLabel[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [pageSize, setPageSize] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [resolveState, setResolveState] = useState<ResolveState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const canResolve = hasRole(authUserRoles, 'Rer') && hasRole(authUserRoles, 'UnitsEditor');

  const loadRows = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await listUnresolvedUnitLabels(
          { page: pageIndex },
          signal ? { signal } : undefined,
        );
        if (signal?.aborted) return;
        setRows(response.rows);
        setTotalCount(response.totalCount);
        setPageSize(response.pageSize);
      } catch (error) {
        if (!signal?.aborted) setError(formatError(error));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [pageIndex],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadRows(controller.signal);
    return () => controller.abort();
  }, [loadRows]);

  async function refreshAfterAction() {
    if (rows.length <= 1 && pageIndex > 0) {
      setPageIndex(pageIndex - 1);
    } else {
      await loadRows();
    }
  }

  async function markBadData(row: UnresolvedUnitLabel) {
    setProcessing(true);
    setError(null);
    try {
      await classifyUnresolvedUnitLabel({ unitTxt: row.unitTxt });
      setStatus(`«${row.unitTxt}» позначено як погані дані.`);
      await refreshAfterAction();
    } catch (error) {
      setError(formatError(error));
    } finally {
      setProcessing(false);
    }
  }

  async function resolveGroup() {
    if (!resolveState?.orbitUnit) return;
    setProcessing(true);
    setError(null);
    try {
      await resolveUnresolvedUnitLabel({
        unitTxt: resolveState.row.unitTxt,
        label: resolveState.label,
        orbitUnitId: resolveState.orbitUnit.unitId,
      });
      setStatus(`«${resolveState.row.unitTxt}» передано на перевірку прив'язки.`);
      setResolveState(null);
      await refreshAfterAction();
    } catch (error) {
      setError(formatError(error));
    } finally {
      setProcessing(false);
    }
  }

  const columns = useMemo<MRT_ColumnDef<UnresolvedUnitLabel>[]>(
    () => [
      {
        accessorKey: 'unitTxt',
        header: 'Текст підрозділу',
        size: 600,
        Cell: ({ cell }) => (
          <Box sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {String(cell.getValue() ?? '')}
          </Box>
        ),
      },
      {
        accessorKey: 'quantity',
        header: 'Кількість',
        size: 140,
      },
    ],
    [],
  );

  return (
    <TableStateProvider
      tableId="admin-unit-unparsed"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMN_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <Stack spacing={1.5} sx={{ height: '100%', minHeight: 0, p: 2 }}>
        <TablePageToolbar
          title="Нерозпізнані підрозділи"
          trailingActionsAfterInternal={
            <Tooltip title="Оновити">
              <span>
                <IconButton
                  size="small"
                  disabled={loading || processing}
                  onClick={() => void loadRows()}
                >
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          }
        />
        {error ? (
          <PowerAlert severity="error" onClose={() => setError(null)}>
            {error}
          </PowerAlert>
        ) : null}
        {status ? (
          <PowerAlert severity="success" onClose={() => setStatus(null)}>
            {status}
          </PowerAlert>
        ) : null}
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <SettingsNeoTable
            columns={columns}
            data={rows}
            loading={loading}
            manualFiltering
            manualSorting
            enableRowActions
            renderRowActions={({ row }) => (
              <MrtRowActions forceMenu>
                <MrtRowActionButton
                  label="Погані дані"
                  icon={<BlockIcon fontSize="small" />}
                  tone="danger"
                  disabled={processing}
                  onClick={() => void markBadData(row.original)}
                />
                <MrtRowActionButton
                  label="Прив'язати до підрозділу"
                  icon={<LinkIcon fontSize="small" />}
                  opensModal
                  disabled={!canResolve || processing}
                  onClick={() => {
                    setError(null);
                    setResolveState({
                      row: row.original,
                      label: row.original.unitTxt,
                      orbitUnit: null,
                    });
                  }}
                />
              </MrtRowActions>
            )}
            tablePaperSx={{ height: '100%', minHeight: 0 }}
            tableContainerSx={{ maxHeight: '100%' }}
          />
        </Box>
        <Stack direction="row" justifyContent="center">
          <Pagination
            count={Math.max(1, pageSize ? Math.ceil(totalCount / pageSize) : 1)}
            page={pageIndex + 1}
            disabled={loading || processing}
            onChange={(_, page) => setPageIndex(page - 1)}
            showFirstButton
            showLastButton
          />
        </Stack>
      </Stack>

      <Dialog
        open={resolveState !== null}
        fullWidth
        maxWidth="sm"
        onClose={processing ? undefined : () => setResolveState(null)}
      >
        <DialogTitle>Прив'язати до підрозділу</DialogTitle>
        <DialogContent>
          {resolveState ? (
            <Stack spacing={2} sx={{ pt: 1 }}>
              <Typography variant="body2" color="text.secondary">
                Нерозпізнаний текст: {resolveState.row.unitTxt}
              </Typography>
              <TextField
                autoFocus
                fullWidth
                label="Тег підрозділу"
                value={resolveState.label}
                disabled={processing}
                error={resolveState.label.trim().length < 2}
                helperText={
                  resolveState.label.trim().length < 2
                    ? 'Тег має містити щонайменше 2 символи.'
                    : 'Текст можна відредагувати перед збереженням.'
                }
                onChange={(event) =>
                  setResolveState({ ...resolveState, label: event.target.value })
                }
              />
              <Box>
                <Button
                  variant="outlined"
                  startIcon={<LinkIcon />}
                  disabled={processing}
                  onClick={() => setPickerOpen(true)}
                >
                  Обрати підрозділ ORBIT
                </Button>
              </Box>
              <Typography variant="body2">
                {resolveState.orbitUnit
                  ? `Обрано: ${resolveState.orbitUnit.fullName}`
                  : 'Підрозділ ORBIT не обрано.'}
              </Typography>
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResolveState(null)} disabled={processing}>
            Скасувати
          </Button>
          <Button
            variant="contained"
            disabled={
              processing ||
              resolveState === null ||
              resolveState.label.trim().length < 2 ||
              resolveState.orbitUnit === null
            }
            onClick={() => void resolveGroup()}
          >
            {processing ? 'Збереження…' : "Прив'язати"}
          </Button>
        </DialogActions>
      </Dialog>

      {pickerOpen ? (
        <OrbitUnitPickerDialog
          title="Оберіть підрозділ ORBIT"
          searchUnits={searchUnresolvedUnitOrbitUnits}
          onClose={() => setPickerOpen(false)}
          onSelected={(unit) => {
            setResolveState((current) => (current ? { ...current, orbitUnit: unit } : current));
            setPickerOpen(false);
          }}
        />
      ) : null}
    </TableStateProvider>
  );
}
