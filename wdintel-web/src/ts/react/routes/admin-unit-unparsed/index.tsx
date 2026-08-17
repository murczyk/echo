import ArchiveIcon from '@mui/icons-material/Archive';
import EditNoteIcon from '@mui/icons-material/EditNote';
import UnarchiveIcon from '@mui/icons-material/Unarchive';
import LinkIcon from '@mui/icons-material/Link';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
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

import type {
  Unit,
  UnresolvedUnitLabel,
  UnresolvedUnitLabelArchiveFilter,
} from '../../../../Bindings';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerChip } from '../../components/PowerChip';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import { HttpRequestError } from '../../services/api/client';
import {
  DEFAULT_LIST_UNITS_REQ,
  searchUnitsByMatchTier,
  type UnitSearchMatches,
} from '../../services/api/units';
import {
  archiveUnresolvedUnitLabel,
  listUnresolvedUnitLabels,
  resolveUnresolvedUnitLabel,
  updateUnresolvedUnitLabelNote,
} from '../../services/api/unresolved-unit-labels';
import { hasRole } from '../../utils/roles';
import { SettingsNeoTable } from '../settings-neo/SettingsNeoTable';

const DEFAULT_COLUMN_ORDER = ['mrt-row-numbers', 'unitTxt', 'quantity', 'note', 'mrt-row-actions'];
const DEFAULT_COLUMN_VISIBILITY = {
  unitTxt: true,
  quantity: true,
  note: true,
  'mrt-row-actions': true,
};
const UNIT_SEARCH_DEBOUNCE_MS = 300;

type ArchiveFilter = 'all' | 'new' | 'archived';

const ARCHIVE_FILTER_REQ: Record<ArchiveFilter, UnresolvedUnitLabelArchiveFilter> = {
  all: 'AllUnresolvedUnitLabels',
  new: 'NewUnresolvedUnitLabels',
  archived: 'ArchivedUnresolvedUnitLabels',
};

function formatError(error: unknown): string {
  if (error instanceof HttpRequestError && error.message.trim()) return error.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Помилка запиту до сервера.';
}

function unitSegments(unit: Unit): string {
  return [
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
    .filter(Boolean)
    .join(' ');
}

function unitTitle(unit: Unit): string {
  const segments = unitSegments(unit);
  return segments ? `${unit.name} — ${segments}` : unit.name;
}

function unitEchelon(unit: Unit): number {
  return [
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
  ].findIndex((segment) => segment.trim().length > 0);
}

type UnitOption = {
  unit: Unit;
  strict: boolean;
};

function sortUnitsByDescendingEchelon(units: Unit[]): Unit[] {
  return [...units].sort((left, right) => unitEchelon(right) - unitEchelon(left));
}

function sortUnitMatches(matches: UnitSearchMatches): UnitOption[] {
  return [
    ...sortUnitsByDescendingEchelon(matches.strict).map((unit) => ({ unit, strict: true })),
    ...sortUnitsByDescendingEchelon(matches.relaxed).map((unit) => ({ unit, strict: false })),
  ];
}

function ArchiveFilterChips({
  value,
  onChange,
}: {
  value: ArchiveFilter;
  onChange: (value: ArchiveFilter) => void;
}) {
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <PowerChip
        selected={value === 'all'}
        onClick={() => onChange('all')}
        label="Всі"
        interactive
        fontWeight={700}
      />
      <PowerChip
        selected={value === 'new'}
        onClick={() => onChange('new')}
        label="Нові"
        interactive
        fontWeight={700}
      />
      <PowerChip
        selected={value === 'archived'}
        onClick={() => onChange('archived')}
        label="Архів"
        interactive
        fontWeight={700}
      />
    </Stack>
  );
}

function UnitCandidateButton({
  unit,
  strict,
  selected,
  disabled,
  onClick,
}: {
  unit: Unit;
  strict: boolean;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant={selected ? 'contained' : 'outlined'}
      color={unit.active ? 'primary' : 'warning'}
      disabled={disabled}
      onClick={onClick}
      sx={{ justifyContent: 'flex-start', textAlign: 'left', py: 1 }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="flex-start"
        sx={{ minWidth: 0, width: '100%' }}
      >
        {strict ? (
          <Box component="span" aria-label="Точний збіг" sx={{ lineHeight: 1.5 }}>
            ⭐
          </Box>
        ) : null}
        <Stack spacing={0.5} sx={{ minWidth: 0, width: '100%' }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
              {unit.name || `#${unit.id}`}
            </Typography>
            <Chip
              size="small"
              label={unit.active ? 'Активний' : 'Неактивний'}
              color={unit.active ? 'success' : 'warning'}
              variant={selected ? 'filled' : 'outlined'}
            />
          </Stack>
          {unitSegments(unit) ? (
            <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {unitSegments(unit)}
            </Typography>
          ) : null}
        </Stack>
      </Stack>
    </Button>
  );
}

type ResolveState = {
  row: UnresolvedUnitLabel;
  sigintUnit: Unit | null;
};

type NoteState = {
  row: UnresolvedUnitLabel;
  note: string;
};

type AdminUnitUnparsedPageProps = {
  authUserRoles: string[];
  embedded?: boolean;
};

export function AdminUnitUnparsedPage({
  authUserRoles,
  embedded = false,
}: AdminUnitUnparsedPageProps) {
  const [rows, setRows] = useState<UnresolvedUnitLabel[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>('new');
  const [totalCount, setTotalCount] = useState(0);
  const [pageSize, setPageSize] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [noteState, setNoteState] = useState<NoteState | null>(null);
  const [resolveState, setResolveState] = useState<ResolveState | null>(null);
  const [unitSearch, setUnitSearch] = useState('');
  const [unitOptions, setUnitOptions] = useState<UnitOption[]>([]);
  const [unitLoading, setUnitLoading] = useState(false);
  const [unitSearchError, setUnitSearchError] = useState<string | null>(null);
  const canResolve =
    hasRole(authUserRoles, 'Admin') &&
    hasRole(authUserRoles, 'Rer') &&
    hasRole(authUserRoles, 'UnitsEditor');
  const resolveRowText = resolveState?.row.unitTxt ?? null;

  const loadRows = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await listUnresolvedUnitLabels(
          { page: pageIndex, archiveFilter: ARCHIVE_FILTER_REQ[archiveFilter] },
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
    [archiveFilter, pageIndex],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadRows(controller.signal);
    return () => controller.abort();
  }, [loadRows]);

  useEffect(() => {
    if (resolveRowText === null) {
      setUnitOptions([]);
      setUnitSearchError(null);
      setUnitLoading(false);
      return;
    }

    const controller = new AbortController();
    const search = unitSearch.trim() || resolveRowText;
    setUnitLoading(true);
    setUnitSearchError(null);
    setUnitOptions([]);
    const timeout = window.setTimeout(() => {
      void searchUnitsByMatchTier(
        {
          ...DEFAULT_LIST_UNITS_REQ,
          sortBy: 'UnitNameLengthAsc',
          includeInactive: true,
          filterText: search,
          limit: 50,
          offset: 0,
        },
        { signal: controller.signal },
      )
        .then((matches) => {
          if (!controller.signal.aborted) {
            setUnitOptions(sortUnitMatches(matches));
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) setUnitSearchError(formatError(error));
        })
        .finally(() => {
          if (!controller.signal.aborted) setUnitLoading(false);
        });
    }, UNIT_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [resolveRowText, unitSearch]);

  async function refreshAfterAction() {
    if (rows.length <= 1 && pageIndex > 0) {
      setPageIndex(pageIndex - 1);
    } else {
      await loadRows();
    }
  }

  async function setArchived(row: UnresolvedUnitLabel, archived: boolean) {
    setProcessing(true);
    setError(null);
    try {
      await archiveUnresolvedUnitLabel({ unitTxt: row.unitTxt, archived });
      setStatus(
        archived ? `«${row.unitTxt}» перенесено в архів.` : `«${row.unitTxt}» повернено з архіву.`,
      );
      await refreshAfterAction();
    } catch (error) {
      setError(formatError(error));
    } finally {
      setProcessing(false);
    }
  }

  const saveNote = useCallback(async (row: UnresolvedUnitLabel, note: string) => {
    setProcessing(true);
    setError(null);
    try {
      await updateUnresolvedUnitLabelNote({
        unitTxt: row.unitTxt,
        note,
        isArchived: row.isArchived,
      });
      setRows((currentRows) =>
        currentRows.map((currentRow) =>
          currentRow.unitTxt === row.unitTxt && currentRow.isArchived === row.isArchived
            ? { ...currentRow, note }
            : currentRow,
        ),
      );
      setStatus(`Нотатку для «${row.unitTxt}» збережено.`);
      return true;
    } catch (error) {
      setError(formatError(error));
      return false;
    } finally {
      setProcessing(false);
    }
  }, []);

  async function resolveGroup() {
    if (!resolveState?.sigintUnit) return;
    setProcessing(true);
    setError(null);
    try {
      await resolveUnresolvedUnitLabel({
        unitTxt: resolveState.row.unitTxt,
        label: resolveState.row.unitTxt,
        sigintUnitId: resolveState.sigintUnit.id,
      });
      setStatus(`Синонім для «${resolveState.row.unitTxt}» збережено.`);
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
        size: 520,
        Cell: ({ cell }) => (
          <Box sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {String(cell.getValue() ?? '')}
          </Box>
        ),
      },
      {
        accessorKey: 'quantity',
        header: 'Кількість',
        size: 120,
      },
      {
        accessorKey: 'note',
        header: 'Нотатка',
        size: 360,
        enableSorting: false,
        Cell: ({ cell }) => (
          <Box sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {String(cell.getValue() || '—')}
          </Box>
        ),
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
      <Stack spacing={1.5} sx={{ height: '100%', minHeight: 0, p: embedded ? 0 : 2 }}>
        <TablePageToolbar
          title="Нерозпізнані підрозділи"
          trailingActionsBeforeInternal={
            <ArchiveFilterChips
              value={archiveFilter}
              onChange={(value) => {
                setArchiveFilter(value);
                setPageIndex(0);
              }}
            />
          }
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
                  label="Редагувати нотатку"
                  icon={<EditNoteIcon fontSize="small" />}
                  opensModal
                  disabled={processing}
                  onClick={() => setNoteState({ row: row.original, note: row.original.note })}
                />
                <MrtRowActionButton
                  label={row.original.isArchived ? 'Розархівувати' : 'Архів'}
                  icon={
                    row.original.isArchived ? (
                      <UnarchiveIcon fontSize="small" />
                    ) : (
                      <ArchiveIcon fontSize="small" />
                    )
                  }
                  tone={row.original.isArchived ? undefined : 'danger'}
                  disabled={processing}
                  onClick={() => void setArchived(row.original, !row.original.isArchived)}
                />
                {!row.original.isArchived ? (
                  <MrtRowActionButton
                    label="Прив'язати до підрозділу"
                    icon={<LinkIcon fontSize="small" />}
                    opensModal
                    disabled={!canResolve || processing}
                    onClick={() => {
                      setError(null);
                      setUnitSearch(row.original.unitTxt);
                      setUnitOptions([]);
                      setUnitSearchError(null);
                      setResolveState({
                        row: row.original,
                        sigintUnit: null,
                      });
                    }}
                  />
                ) : null}
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
        open={noteState !== null}
        fullWidth
        maxWidth="sm"
        onClose={processing ? undefined : () => setNoteState(null)}
      >
        <DialogTitle>Редагувати нотатку для {noteState?.row.unitTxt}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={3}
            label="Нотатка"
            value={noteState?.note ?? ''}
            disabled={processing}
            onChange={(event) =>
              setNoteState((current) =>
                current ? { ...current, note: event.target.value } : current,
              )
            }
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNoteState(null)} disabled={processing}>
            Скасувати
          </Button>
          <Button
            variant="contained"
            disabled={processing || noteState === null}
            onClick={() => {
              if (noteState === null) return;
              void saveNote(noteState.row, noteState.note.trim()).then((saved) => {
                if (saved) setNoteState(null);
              });
            }}
          >
            {processing ? 'Збереження…' : 'Зберегти'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={resolveState !== null}
        fullWidth
        maxWidth="md"
        onClose={processing ? undefined : () => setResolveState(null)}
      >
        <DialogTitle>Прив'язати до підрозділу {resolveState?.row.unitTxt}</DialogTitle>
        <DialogContent>
          {resolveState ? (
            <Stack spacing={2} sx={{ pt: 1 }}>
              {unitOptions.length > 0 ? (
                <Stack spacing={1}>
                  <Typography variant="subtitle2">Топ кандидатів</Typography>
                  {unitOptions.slice(0, 3).map(({ unit, strict }) => (
                    <UnitCandidateButton
                      key={unit.id}
                      unit={unit}
                      strict={strict}
                      selected={resolveState.sigintUnit?.id === unit.id}
                      disabled={processing}
                      onClick={() =>
                        setResolveState((current) =>
                          current ? { ...current, sigintUnit: unit } : current,
                        )
                      }
                    />
                  ))}
                </Stack>
              ) : null}
              <TextField
                fullWidth
                label="Пошук підрозділу SIGINT"
                value={unitSearch}
                disabled={processing}
                helperText="Пошук включає неактивні підрозділи. Неактивний підрозділ буде активовано після збереження синоніму."
                onChange={(event) => setUnitSearch(event.target.value)}
              />
              {unitSearchError ? <PowerAlert severity="error">{unitSearchError}</PowerAlert> : null}
              <Stack spacing={1}>
                {unitLoading ? (
                  <Stack direction="row" alignItems="center" spacing={1}>
                    <CircularProgress size={18} />
                    <Typography variant="body2" color="text.secondary">
                      Пошук підрозділів…
                    </Typography>
                  </Stack>
                ) : null}
                {!unitLoading && unitOptions.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    Підрозділів не знайдено.
                  </Typography>
                ) : null}
                {unitOptions.slice(3).map(({ unit, strict }) => (
                  <UnitCandidateButton
                    key={unit.id}
                    unit={unit}
                    strict={strict}
                    selected={resolveState.sigintUnit?.id === unit.id}
                    disabled={processing}
                    onClick={() =>
                      setResolveState((current) =>
                        current ? { ...current, sigintUnit: unit } : current,
                      )
                    }
                  />
                ))}
              </Stack>
              <Typography variant="body2">
                {resolveState.sigintUnit
                  ? `Обрано: ${unitTitle(resolveState.sigintUnit)}`
                  : 'Підрозділ SIGINT не обрано.'}
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
            disabled={processing || resolveState === null || resolveState.sigintUnit === null}
            onClick={() => void resolveGroup()}
          >
            {processing ? 'Збереження…' : "Прив'язати"}
          </Button>
        </DialogActions>
      </Dialog>
    </TableStateProvider>
  );
}
