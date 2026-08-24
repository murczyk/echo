import CancelIcon from '@mui/icons-material/Cancel';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import EditIcon from '@mui/icons-material/Edit';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import SyncAltIcon from '@mui/icons-material/SyncAlt';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, MouseEvent as ReactMouseEvent } from 'react';

import type { UnitNameReview } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import {
  type AppMrtColumnDef,
  mrtCustomCell,
} from '../../components/mui-customized/table/get-default-table-options';
import { MrtOverflowText } from '../../components/mui-customized/table/mrt-overflow';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import {
  confirmUnitNameReview,
  getUnitNameReviews,
  updateUnitNameReview,
} from '../../services/api/units';
import { handleNavigateWithinSpaClick } from '../../utils/browser';
import { hasRole } from '../../utils/roles';
import { SettingsNeoTable } from '../settings-neo/SettingsNeoTable';
import { formatUnitError } from '../rer-units-neo/helpers';

const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'currentName',
  'expectedName',
  'matchesExpected',
  'replace',
  'edit',
  'confirm',
];

const DEFAULT_COLUMN_VISIBILITY = {
  currentName: true,
  expectedName: true,
  matchesExpected: true,
  replace: true,
  edit: true,
  confirm: true,
};

const EXPECTED_NAME_EXPLAINER =
  'Непорожні значення полів екіпаж/команда, відділення, ланка, взвод, рота, батальйон, полк, бригада, дивізія, корпус та армія, об’єднані пробілами в цьому порядку.';

type AdminUnitNamesPageProps = {
  authUserRoles: string[];
  embedded?: boolean;
};

function sortReviews(units: UnitNameReview[]): UnitNameReview[] {
  return [...units].sort(
    (left, right) => left.updatedAt - right.updatedAt || left.sigintUnitId - right.sigintUnitId,
  );
}

export function AdminUnitNamesPage({ authUserRoles, embedded = false }: AdminUnitNamesPageProps) {
  const [units, setUnits] = useState<UnitNameReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [submittingUnitId, setSubmittingUnitId] = useState<number | null>(null);
  const [editingUnit, setEditingUnit] = useState<UnitNameReview | null>(null);
  const [editedName, setEditedName] = useState('');
  const canEdit = hasRole(authUserRoles, 'Rer') && hasRole(authUserRoles, 'UnitsEditor');

  const loadUnits = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      setUnits(sortReviews(await getUnitNameReviews(signal ? { signal } : undefined)));
    } catch (error) {
      if (!signal?.aborted) setLoadError(formatUnitError(error));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadUnits(controller.signal);
    return () => controller.abort();
  }, [loadUnits]);

  const applyReview = useCallback((review: UnitNameReview) => {
    setUnits((current) =>
      sortReviews(
        current.map((unit) => (unit.sigintUnitId === review.sigintUnitId ? review : unit)),
      ),
    );
  }, []);

  const replaceName = useCallback(
    async (unit: UnitNameReview, name: string, successMessage: string) => {
      setSubmittingUnitId(unit.sigintUnitId);
      setActionError(null);
      setStatus(null);
      try {
        applyReview(await updateUnitNameReview({ sigintUnitId: unit.sigintUnitId, name }));
        setStatus(successMessage);
        return true;
      } catch (error) {
        setActionError(formatUnitError(error));
        return false;
      } finally {
        setSubmittingUnitId(null);
      }
    },
    [applyReview],
  );

  const confirmName = useCallback(
    async (unit: UnitNameReview) => {
      setSubmittingUnitId(unit.sigintUnitId);
      setActionError(null);
      setStatus(null);
      try {
        applyReview(await confirmUnitNameReview({ sigintUnitId: unit.sigintUnitId }));
        setStatus('Назву підрозділу підтверджено');
      } catch (error) {
        setActionError(formatUnitError(error));
      } finally {
        setSubmittingUnitId(null);
      }
    },
    [applyReview],
  );

  const columns = useMemo<AppMrtColumnDef<UnitNameReview>[]>(
    () => [
      {
        id: 'currentName',
        accessorKey: 'currentName',
        header: 'Поточна назва підрозділу',
        size: 300,
        meta: { overflowMode: 'custom', overflowOwner: 'shared-text', interactive: true },
        Cell: mrtCustomCell<UnitNameReview>(({ row }) => {
          const href = `/rer-units/${row.original.sigintUnitId}`;
          const label = row.original.currentName || `#${row.original.sigintUnitId}`;
          return (
            <MrtOverflowText
              displayValue={label}
              fullValue={label}
              interactive
              component="a"
              componentProps={{
                href,
                onClick: (event: ReactMouseEvent<HTMLElement>) =>
                  handleNavigateWithinSpaClick(event, href),
              }}
            />
          );
        }),
      },
      {
        id: 'expectedName',
        accessorKey: 'expectedName',
        header: 'Очікувана назва підрозділу',
        Header: () => (
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Typography variant="body2" fontWeight={600}>
              Очікувана назва підрозділу
            </Typography>
            <Tooltip title={EXPECTED_NAME_EXPLAINER}>
              <InfoOutlinedIcon fontSize="small" color="action" />
            </Tooltip>
          </Stack>
        ),
        size: 340,
        meta: { overflowMode: 'custom', overflowOwner: 'shared-text' },
        Cell: mrtCustomCell<UnitNameReview>(({ row }) => (
          <MrtOverflowText
            displayValue={row.original.expectedName || '—'}
            fullValue={row.original.expectedName || '—'}
          />
        )),
      },
      {
        id: 'matchesExpected',
        accessorFn: (row) => row.matchesExpected,
        header: 'Співпадає',
        size: 120,
        meta: { overflowMode: 'none' },
        Cell: ({ row }) =>
          row.original.matchesExpected ? (
            <CheckCircleIcon className="text-green-600" fontSize="small" titleAccess="Співпадає" />
          ) : (
            <CancelIcon className="text-red-600" fontSize="small" titleAccess="Не співпадає" />
          ),
      },
      {
        id: 'replace',
        header: 'Замінити на очікувану',
        size: 210,
        meta: { overflowMode: 'none' },
        enableColumnFilter: false,
        enableSorting: false,
        Cell: ({ row }) => (
          <Button
            size="small"
            variant="outlined"
            startIcon={<SyncAltIcon />}
            disabled={
              !canEdit ||
              submittingUnitId !== null ||
              row.original.matchesExpected ||
              !row.original.expectedName.trim()
            }
            onClick={() =>
              void replaceName(
                row.original,
                row.original.expectedName,
                'Назву підрозділу замінено на очікувану',
              )
            }
          >
            Замінити
          </Button>
        ),
      },
      {
        id: 'edit',
        header: 'Редагувати',
        size: 150,
        meta: { overflowMode: 'none' },
        enableColumnFilter: false,
        enableSorting: false,
        Cell: ({ row }) => (
          <Button
            size="small"
            variant="outlined"
            startIcon={<EditIcon />}
            disabled={!canEdit || submittingUnitId !== null}
            onClick={() => {
              setEditingUnit(row.original);
              setEditedName(row.original.currentName);
              setActionError(null);
              setStatus(null);
            }}
          >
            Редагувати
          </Button>
        ),
      },
      {
        id: 'confirm',
        header: 'Підтвердити',
        size: 130,
        meta: { overflowMode: 'none' },
        enableColumnFilter: false,
        enableSorting: false,
        Cell: ({ row }) => (
          <Tooltip title="Підтвердити назву та перемістити підрозділ у кінець списку">
            <span>
              <IconButton
                size="small"
                color="success"
                aria-label="Підтвердити"
                disabled={!canEdit || submittingUnitId !== null}
                onClick={() => void confirmName(row.original)}
              >
                <CheckCircleIcon />
              </IconButton>
            </span>
          </Tooltip>
        ),
      },
    ],
    [canEdit, confirmName, replaceName, submittingUnitId],
  );

  async function submitEdit(event: FormEvent) {
    event.preventDefault();
    if (!editingUnit) return;
    const updated = await replaceName(editingUnit, editedName, 'Назву підрозділу змінено');
    if (updated) setEditingUnit(null);
  }

  return (
    <TableStateProvider
      tableId="admin-unit-names"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMN_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <Stack spacing={1.5} sx={{ height: '100%', minHeight: 0, p: embedded ? 0 : 2 }}>
        <TablePageToolbar
          title="Назви підрозділів"
          withGlobalTextFilter
          trailingActionsAfterInternal={
            <Tooltip title="Оновити">
              <span>
                <IconButton size="small" disabled={loading} onClick={() => void loadUnits()}>
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          }
        />
        {loadError ? <PowerAlert severity="error">{loadError}</PowerAlert> : null}
        {actionError ? <PowerAlert severity="error">{actionError}</PowerAlert> : null}
        {status ? <PowerAlert severity="success">{status}</PowerAlert> : null}
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <SettingsNeoTable
            columns={columns}
            data={units}
            loading={loading}
            layoutMode="grid"
            tablePaperSx={{ height: '100%', minHeight: 0 }}
            tableContainerSx={{ maxHeight: '100%' }}
          />
        </Box>
      </Stack>
      <Dialog
        open={editingUnit !== null}
        onClose={() => submittingUnitId === null && setEditingUnit(null)}
        fullWidth
        maxWidth="sm"
        component="form"
        onSubmit={(event) => void submitEdit(event)}
      >
        <DialogTitle>Редагувати назву підрозділу</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="Назва підрозділу"
            value={editedName}
            onChange={(event) => setEditedName(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button disabled={submittingUnitId !== null} onClick={() => setEditingUnit(null)}>
            Скасувати
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={submittingUnitId !== null || !editedName.trim()}
          >
            Зберегти
          </Button>
        </DialogActions>
      </Dialog>
    </TableStateProvider>
  );
}
