import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import {
  Box,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import type { MRT_ColumnDef } from 'material-react-table';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { TagAdmin, TagUpsertReq } from '../../../../Bindings';
import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { SectionEmptyState } from '../../components/SectionEmptyState';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../components/dialogStyles';
import { GlobalFilterTextField } from '../../components/mui-customized/table/components/table-top-toolbar/components/global-filter-text-field';
import { CUSTOM_CELL_STYLES } from '../../components/mui-customized/table/custom-styles';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import {
  createOrganismTag,
  deleteOrganismTag,
  listOrganismTags,
  updateOrganismTag,
} from '../../services/api/tags';
import { SettingsNeoTable } from '../settings-neo/SettingsNeoTable';

type LoadStatus = 'idle' | 'loading' | 'success' | 'error';

type TagFormState = {
  label: string;
  extra: boolean;
  ord: string;
  enabled: boolean;
  isPalitra: boolean;
};

const emptyTagForm: TagFormState = {
  label: '',
  extra: false,
  ord: '',
  enabled: true,
  isPalitra: false,
};

// Wide enough for the inline "Редагувати" button plus the overflow menu trigger
// so neither is clipped.
const ORGANISM_TAGS_ACTIONS_COLUMN_SIZE = 81;

const ORGANISM_TAGS_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'tagId',
  'label',
  'extra',
  'ord',
  'enabled',
  'isPalitra',
];

const ORGANISM_TAGS_COLUMN_VISIBILITY = {
  tagId: true,
  label: true,
  extra: true,
  ord: true,
  enabled: true,
  isPalitra: true,
};

function formFromTag(tag: TagAdmin): TagFormState {
  return {
    label: tag.label,
    extra: Boolean(tag.extra),
    ord: tag.ord == null ? '' : String(tag.ord),
    enabled: tag.enabled,
    isPalitra: tag.isPalitra,
  };
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

function formatYesNo(value: boolean | null | undefined): string {
  return value ? 'так' : 'ні';
}

// The DELETE endpoint soft-deletes by setting `enabled = false`, and the admin list
// returns disabled rows too — the same DB state as a tag disabled via "Вимкнути" or
// created with "Активний" off. Blanket-filtering `enabled === false` would keep
// deletions sticky but also hide those legitimately-disabled tags, making them
// unreachable via "Увімкнути". Instead, track explicitly-deleted tag ids client-side
// (per organism) so only actual deletions stay hidden across reloads.
const DELETED_TAG_IDS_STORAGE_PREFIX = 'echo:organism-tags:deleted:';

function deletedTagIdsStorageKey(organismId: number): string {
  return `${DELETED_TAG_IDS_STORAGE_PREFIX}${organismId}`;
}

function readDeletedTagIds(organismId: number): Set<number> {
  try {
    const raw = localStorage.getItem(deletedTagIdsStorageKey(organismId));
    if (raw == null) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is number => typeof id === 'number'))
      : new Set();
  } catch (_) {
    return new Set();
  }
}

function writeDeletedTagIds(organismId: number, ids: Set<number>): void {
  try {
    localStorage.setItem(deletedTagIdsStorageKey(organismId), JSON.stringify(Array.from(ids)));
  } catch (_) {
    // Ignore storage failures (private mode, quota, etc.) — the deletion just won't
    // stay hidden across a reload in that case.
  }
}

function markTagDeleted(organismId: number, tagId: number): void {
  const ids = readDeletedTagIds(organismId);
  ids.add(tagId);
  writeDeletedTagIds(organismId, ids);
}

function TagsSearchField() {
  const tableStateContext = useTableStateContext();
  return (
    <GlobalFilterTextField
      globalFilter={tableStateContext.globalFilter}
      setGlobalFilter={tableStateContext.onChangeGlobalFilter}
    />
  );
}

function TagOptionToggle({
  label,
  description,
  checked,
  onToggle,
}: {
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <FormControlLabel
      sx={{ alignItems: 'flex-start', m: 0, gap: 1.5, py: 0.75 }}
      control={<Switch checked={checked} onChange={onToggle} />}
      label={
        <Stack spacing={0.25} sx={{ pt: 0.5 }}>
          <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.3 }}>
            {label}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', lineHeight: 1.4 }}>
            {description}
          </Typography>
        </Stack>
      }
    />
  );
}

export function OrganismTagsSection({ organismId }: { organismId: number | null }) {
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [tags, setTags] = useState<TagAdmin[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTag, setEditingTag] = useState<TagAdmin | null>(null);
  const [form, setForm] = useState<TagFormState>(emptyTagForm);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [labelTouched, setLabelTouched] = useState(false);
  const [deletingTag, setDeletingTag] = useState<TagAdmin | null>(null);
  const [deleteInFlight, setDeleteInFlight] = useState(false);

  const isLabelValid = form.label.trim().length > 0;
  const showLabelError = labelTouched && !isLabelValid;

  useEffect(() => {
    if (organismId == null) {
      setStatus('idle');
      setTags([]);
      return;
    }

    const abortController = new AbortController();

    async function loadTags(id: number) {
      setStatus('loading');
      setError(null);
      try {
        const data = await listOrganismTags(id);
        if (abortController.signal.aborted) return;
        // Hide only tags explicitly deleted from this browser (see
        // DELETED_TAG_IDS_STORAGE_PREFIX above) — legitimately-disabled tags
        // (enabled === false via "Вимкнути" or "Активний" off) still show up so admins
        // can recover them through "Увімкнути".
        const deletedTagIds = readDeletedTagIds(id);
        setTags(data.filter((tag) => !deletedTagIds.has(tag.tagId)));
        setStatus('success');
      } catch (loadError) {
        if (abortController.signal.aborted) return;
        setError(`Помилка завантаження тегів: ${formatErrorMessage(loadError)}`);
        setStatus('error');
      }
    }

    void loadTags(organismId);

    return () => {
      abortController.abort();
    };
  }, [organismId]);

  const openCreateDialog = useCallback(() => {
    setEditingTag(null);
    setForm(emptyTagForm);
    setLabelTouched(false);
    setError(null);
    setDialogOpen(true);
  }, []);

  const openEditDialog = useCallback((tag: TagAdmin) => {
    setEditingTag(tag);
    setForm(formFromTag(tag));
    setLabelTouched(false);
    setError(null);
    setDialogOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setEditingTag(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (organismId == null) return;

    const req: TagUpsertReq = {
      label: form.label.trim(),
      extra: form.extra,
      ord: form.ord === '' ? null : Number(form.ord),
      enabled: form.enabled,
      isPalitra: form.isPalitra,
      ownerOrganismId: organismId,
    };

    setSaveInFlight(true);
    setError(null);
    try {
      if (editingTag == null) {
        const created = await createOrganismTag(organismId, req);
        setTags((current) => [...current, created]);
      } else {
        const updated = await updateOrganismTag(organismId, editingTag.tagId, req);
        setTags((current) => current.map((tag) => (tag.tagId === updated.tagId ? updated : tag)));
      }
      setDialogOpen(false);
      setEditingTag(null);
    } catch (saveError) {
      setError(`Помилка збереження тегу: ${formatErrorMessage(saveError)}`);
    } finally {
      setSaveInFlight(false);
    }
  }, [editingTag, form, organismId]);

  const handleToggleEnabled = useCallback(
    async (tag: TagAdmin) => {
      if (organismId == null) return;

      setError(null);
      try {
        const req: TagUpsertReq = {
          label: tag.label,
          extra: tag.extra,
          ord: tag.ord,
          enabled: !tag.enabled,
          isPalitra: tag.isPalitra,
          ownerOrganismId: organismId,
        };
        const updated = await updateOrganismTag(organismId, tag.tagId, req);
        setTags((current) =>
          current.map((item) => (item.tagId === updated.tagId ? updated : item)),
        );
      } catch (toggleError) {
        const action = tag.enabled ? 'вимкнення' : 'увімкнення';
        setError(`Помилка ${action} тегу: ${formatErrorMessage(toggleError)}`);
      }
    },
    [organismId],
  );

  const openDeleteDialog = useCallback((tag: TagAdmin) => {
    setError(null);
    setDeletingTag(tag);
  }, []);

  const closeDeleteDialog = useCallback(() => {
    setDeletingTag(null);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (organismId == null || deletingTag == null) return;

    const tagId = deletingTag.tagId;
    setDeleteInFlight(true);
    setError(null);
    try {
      await deleteOrganismTag(organismId, tagId);
      markTagDeleted(organismId, tagId);
      setTags((current) => current.filter((item) => item.tagId !== tagId));
      setDeletingTag(null);
    } catch (deleteError) {
      setError(`Помилка видалення тегу: ${formatErrorMessage(deleteError)}`);
    } finally {
      setDeleteInFlight(false);
    }
  }, [deletingTag, organismId]);

  const columns = useMemo<MRT_ColumnDef<TagAdmin>[]>(() => {
    const noWrapCellProps = { sx: { ...CUSTOM_CELL_STYLES, whiteSpace: 'nowrap' } };
    return [
      { header: 'ID', accessorKey: 'tagId', size: 80 },
      { header: 'Назва', accessorKey: 'label', size: 200 },
      {
        header: 'Додатковий',
        id: 'extra',
        accessorFn: (row) => formatYesNo(row.extra),
        size: 150,
        muiTableHeadCellProps: noWrapCellProps,
        muiTableBodyCellProps: noWrapCellProps,
      },
      {
        header: 'Порядок',
        id: 'ord',
        accessorFn: (row) => (row.ord == null ? '—' : row.ord),
        size: 130,
        muiTableHeadCellProps: noWrapCellProps,
        muiTableBodyCellProps: noWrapCellProps,
      },
      {
        header: 'Активний',
        id: 'enabled',
        accessorFn: (row) => formatYesNo(row.enabled),
        size: 140,
        muiTableHeadCellProps: noWrapCellProps,
        muiTableBodyCellProps: noWrapCellProps,
      },
      {
        header: 'Палітра',
        id: 'isPalitra',
        accessorFn: (row) => formatYesNo(row.isPalitra),
        size: 130,
        muiTableHeadCellProps: noWrapCellProps,
        muiTableBodyCellProps: noWrapCellProps,
      },
    ];
  }, []);

  const renderRowActions = useCallback(
    ({ row }: { row: { original: TagAdmin } }) => {
      const tag = row.original;
      return (
        <Stack direction="row" alignItems="center" gap={0.5}>
          {/* Editing is the frequent action, so it stays inline in the "Дії" column. */}
          <MrtRowActionButton
            label="Редагувати"
            icon={<EditOutlinedIcon fontSize="small" />}
            opensModal
            onClick={() => openEditDialog(tag)}
          />
          {/* Less-frequent actions live behind the overflow (three-dots) menu. */}
          <MrtRowActions forceMenu>
            {tag.enabled ? (
              <MrtRowActionButton
                label="Вимкнути"
                icon={<BlockOutlinedIcon fontSize="small" />}
                tone="warning"
                onClick={() => void handleToggleEnabled(tag)}
              />
            ) : (
              <MrtRowActionButton
                label="Увімкнути"
                icon={<CheckCircleOutlinedIcon fontSize="small" />}
                onClick={() => void handleToggleEnabled(tag)}
              />
            )}
            <MrtRowActionButton
              label="Видалити"
              icon={<DeleteOutlineOutlinedIcon fontSize="small" />}
              tone="danger"
              opensModal
              onClick={() => openDeleteDialog(tag)}
            />
          </MrtRowActions>
        </Stack>
      );
    },
    [handleToggleEnabled, openDeleteDialog, openEditDialog],
  );

  if (organismId == null) {
    return <SectionEmptyState message="Спочатку збережіть організм, щоб додати теги." />;
  }

  const isLoading = status === 'loading' || status === 'idle';
  const isEmpty = status === 'success' && tags.length === 0;
  const hasTags = status === 'success' && tags.length > 0;

  return (
    <Box sx={{ pb: 1 }}>
      <Stack spacing={2}>
        {error != null ? <PowerAlert severity="error">{error}</PowerAlert> : null}

        {!hasTags ? (
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="flex-end"
            gap={2}
            flexWrap="wrap"
          >
            <PowerButton variant="contained" onClick={openCreateDialog}>
              Додати тег
            </PowerButton>
          </Stack>
        ) : null}

        {isLoading ? (
          <Box sx={{ py: 2 }} aria-label="Завантаження тегів">
            <CircularProgress size={20} />
          </Box>
        ) : null}

        {isEmpty ? <SectionEmptyState message="У цього організму ще немає тегів." /> : null}

        {hasTags ? (
          <TableStateProvider
            tableId="admin-organism-tags-neo"
            defaultColumnOrder={ORGANISM_TAGS_COLUMN_ORDER}
            defaultColumnVisibility={ORGANISM_TAGS_COLUMN_VISIBILITY}
            defaultEnableColumnOrdering={false}
          >
            <Stack spacing={2}>
              <Stack
                direction="row"
                alignItems="center"
                justifyContent="space-between"
                gap={2}
                flexWrap="wrap"
              >
                <Box sx={{ flex: 1, maxWidth: 320 }}>
                  <TagsSearchField />
                </Box>
                <PowerButton variant="contained" onClick={openCreateDialog}>
                  Додати тег
                </PowerButton>
              </Stack>
              <SettingsNeoTable
                columns={columns}
                data={tags}
                layoutMode="grid"
                enableRowActions
                renderRowActions={renderRowActions}
                rowActionsColumnSize={ORGANISM_TAGS_ACTIONS_COLUMN_SIZE}
              />
            </Stack>
          </TableStateProvider>
        ) : null}
      </Stack>

      <Dialog open={dialogOpen} onClose={closeDialog} fullWidth maxWidth="xs">
        <DialogTitle sx={{ pb: 1.5 }}>
          <Stack spacing={0.25}>
            <Typography component="span" variant="h6" sx={{ fontWeight: 700, lineHeight: 1.3 }}>
              {editingTag == null ? 'Новий тег' : 'Редагувати тег'}
            </Typography>
            <Typography component="span" variant="body2" sx={{ color: 'text.secondary' }}>
              Тег вашого організму, доступний одним кліком на повідомленнях.
            </Typography>
          </Stack>
        </DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <Stack direction="row" spacing={2} alignItems="flex-start">
              <TextField
                label="Назва"
                value={form.label}
                onChange={(event) =>
                  setForm((current) => ({ ...current, label: event.target.value }))
                }
                onBlur={() => setLabelTouched(true)}
                required
                autoFocus
                fullWidth
                error={showLabelError}
                helperText={showLabelError ? 'Обовʼязкове поле' : ' '}
              />
              <TextField
                label="Порядок"
                value={form.ord}
                onChange={(event) =>
                  setForm((current) => ({ ...current, ord: event.target.value }))
                }
                type="number"
                helperText=" "
                sx={{ width: 112, flexShrink: 0 }}
              />
            </Stack>

            <Stack>
              <TagOptionToggle
                label="Активний"
                description="Тег доступний користувачам організму."
                checked={form.enabled}
                onToggle={() => setForm((current) => ({ ...current, enabled: !current.enabled }))}
              />
              <TagOptionToggle
                label="Додатковий"
                description="Показувати у розширеному списку тегів, а не серед основних."
                checked={form.extra}
                onToggle={() => setForm((current) => ({ ...current, extra: !current.extra }))}
              />
              <TagOptionToggle
                label="Палітра"
                description="Використовувати як тег-палітру."
                checked={form.isPalitra}
                onToggle={() =>
                  setForm((current) => ({ ...current, isPalitra: !current.isPalitra }))
                }
              />
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
          <PowerButton variant="outlined" onClick={closeDialog} disabled={saveInFlight}>
            Скасувати
          </PowerButton>
          <PowerButton
            variant="contained"
            onClick={() => void handleSave()}
            disabled={saveInFlight || !isLabelValid}
          >
            Зберегти
          </PowerButton>
        </DialogActions>
      </Dialog>

      <ConfirmDangerDialog
        open={deletingTag != null}
        onClose={closeDeleteDialog}
        onConfirm={() => void handleConfirmDelete()}
        submitting={deleteInFlight}
        title="Видалити тег"
        description={
          deletingTag != null ? `Тег «${deletingTag.label}» буде видалено. Продовжити?` : undefined
        }
        confirmLabel="Видалити"
      />
    </Box>
  );
}
