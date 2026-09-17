import ArchiveIcon from '@mui/icons-material/Archive';
import EditNoteIcon from '@mui/icons-material/EditNote';
import UnarchiveIcon from '@mui/icons-material/Unarchive';
import LinkIcon from '@mui/icons-material/Link';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Pagination,
  Stack,
  TextField,
  Tooltip,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { UnresolvedUnitLabel, UnresolvedUnitLabelArchiveFilter } from '../../../../Bindings';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerIconButton } from '../../components/PowerIconButton';
import { PowerChip } from '../../components/PowerChip';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import type { AppMrtColumnDef } from '../../components/mui-customized/table/get-default-table-options';
import { HttpRequestError } from '../../services/api/client';
import {
  archiveUnresolvedUnitLabel,
  listUnresolvedUnitLabels,
  resolveUnresolvedUnitLabel,
  updateUnresolvedUnitLabelNote,
} from '../../services/api/unresolved-unit-labels';
import { hasRole } from '../../utils/roles';
import { SettingsNeoTable } from '../settings-neo/SettingsNeoTable';
import { UnresolvedUnitLinkDialog } from './UnresolvedUnitLinkDialog';

const DEFAULT_COLUMN_ORDER = [
  'mrt-row-actions',
  'mrt-row-numbers',
  'unitTxt',
  'quantity',
  'note',
  'messageExamples',
];
const DEFAULT_COLUMN_VISIBILITY = {
  unitTxt: true,
  quantity: true,
  note: true,
  messageExamples: true,
  'mrt-row-actions': true,
};

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
  const [resolveRow, setResolveRow] = useState<UnresolvedUnitLabel | null>(null);
  const canResolve =
    hasRole(authUserRoles, 'Admin') &&
    hasRole(authUserRoles, 'Rer') &&
    hasRole(authUserRoles, 'UnitsEditor');

  const loadRows = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await listUnresolvedUnitLabels(
          {
            page: pageIndex,
            archiveFilter: ARCHIVE_FILTER_REQ[archiveFilter],
          },
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

  async function resolveGroup(sigintUnitId: number) {
    if (resolveRow === null) return;
    const row = resolveRow;
    setProcessing(true);
    setError(null);
    try {
      await resolveUnresolvedUnitLabel({
        unitTxt: row.unitTxt,
        label: row.unitTxt,
        sigintUnitId,
      });
      setStatus(`Синонім для «${row.unitTxt}» збережено.`);
      setResolveRow(null);
      await refreshAfterAction();
    } catch (error) {
      setError(formatError(error));
    } finally {
      setProcessing(false);
    }
  }

  const columns = useMemo<AppMrtColumnDef<UnresolvedUnitLabel>[]>(
    () => [
      {
        accessorKey: 'unitTxt',
        header: 'Текст підрозділу',
        size: 520,
        meta: { overflowMode: 'wrap' },
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
        meta: { overflowMode: 'wrap' },
        Cell: ({ cell }) => (
          <Box sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {String(cell.getValue() || '—')}
          </Box>
        ),
      },
      {
        id: 'messageExamples',
        header: 'Приклади перехоплень',
        size: 200,
        enableSorting: false,
        meta: { overflowMode: 'none' },
        Cell: ({ row }) => (
          <Button
            component="a"
            variant="outlined"
            size="small"
            href={`/admin/unparsed-units?title=${encodeURIComponent(row.original.unitTxt)}`}
          >
            Перейти
          </Button>
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
          filter={
            <ArchiveFilterChips
              value={archiveFilter}
              onChange={(value) => {
                setArchiveFilter(value);
                setPageIndex(0);
              }}
            />
          }
          additionalInternalActions={
            <Tooltip title="Оновити">
              <span>
                <PowerIconButton
                  aria-label="Оновити"
                  size="small"
                  disabled={loading || processing}
                  onClick={() => void loadRows()}
                >
                  <RefreshIcon fontSize="small" />
                </PowerIconButton>
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
                      setResolveRow(row.original);
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

      <UnresolvedUnitLinkDialog
        open={resolveRow !== null}
        unitTxt={resolveRow?.unitTxt ?? ''}
        processing={processing}
        onClose={() => setResolveRow(null)}
        onSubmit={(sigintUnitId) => void resolveGroup(sigintUnitId)}
      />
    </TableStateProvider>
  );
}
