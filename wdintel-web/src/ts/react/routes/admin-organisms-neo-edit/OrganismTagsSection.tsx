import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
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
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import type { MRT_ColumnDef } from 'material-react-table';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { TagAdmin, TagUpsertReq } from '../../../../Bindings';
import { MrtRowActionButton } from '../../components/MrtRowActionButton';
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
import { createOrganismTag, listOrganismTags, updateOrganismTag } from '../../services/api/tags';
import { SettingsNeoTable } from '../settings-neo/SettingsNeoTable';

type LoadStatus = 'idle' | 'loading' | 'success' | 'error';

// `enabled` doubles as our soft-delete flag — the "Архів" view surfaces disabled tags so
// admins can still find and re-enable them, with no distinct deleted state and no
// client-only (localStorage) tracking.
type TagsView = 'active' | 'archived';

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

// Wide enough for the inline "Редагувати" button plus the "Вимкнути"/"Увімкнути" toggle
// so neither is clipped.
const ORGANISM_TAGS_ACTIONS_COLUMN_SIZE = 81;

const ORGANISM_TAGS_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'tagId',
  'label',
  'extra',
  'ord',
  'isPalitra',
];

const ORGANISM_TAGS_COLUMN_VISIBILITY = {
  tagId: true,
  label: true,
  extra: true,
  ord: true,
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

function parseOrdValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
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
  const [view, setView] = useState<TagsView>('active');
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

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
        setTags(data);
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
    setFormErrors({});
    setError(null);
    setDialogOpen(true);
  }, []);

  const openEditDialog = useCallback((tag: TagAdmin) => {
    setEditingTag(tag);
    setForm(formFromTag(tag));
    setLabelTouched(false);
    setFormErrors({});
    setError(null);
    setDialogOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setEditingTag(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (organismId == null) return;

    const ordValue = parseOrdValue(form.ord);
    if (form.ord.trim() && ordValue === null) {
      setFormErrors({ ord: 'Некоректне число' });
      return;
    }
    setFormErrors({});

    const req: TagUpsertReq = {
      label: form.label.trim(),
      extra: form.extra,
      ord: ordValue,
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

  const visibleTags = useMemo(
    () => tags.filter((tag) => (view === 'active' ? tag.enabled : !tag.enabled)),
    [tags, view],
  );

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
          <MrtRowActionButton
            label="Редагувати"
            icon={<EditOutlinedIcon fontSize="small" />}
            opensModal
            onClick={() => openEditDialog(tag)}
          />
          {tag.enabled ? (
            <MrtRowActionButton
              label="Вимкнути"
              icon={<BlockOutlinedIcon fontSize="small" />}
              onClick={() => void handleToggleEnabled(tag)}
            />
          ) : (
            <MrtRowActionButton
              label="Увімкнути"
              icon={<CheckCircleOutlinedIcon fontSize="small" />}
              onClick={() => void handleToggleEnabled(tag)}
            />
          )}
        </Stack>
      );
    },
    [handleToggleEnabled, openEditDialog],
  );

  if (organismId == null) {
    return <SectionEmptyState message="Спочатку збережіть організм, щоб додати теги." />;
  }

  const isLoading = status === 'loading' || status === 'idle';
  const hasAnyTags = status === 'success' && tags.length > 0;
  const isEmpty = status === 'success' && tags.length === 0;
  const isEmptyView = hasAnyTags && visibleTags.length === 0;
  const emptyViewMessage =
    view === 'active'
      ? 'Немає активних тегів. Перемкніться на «Архів», щоб побачити вимкнені.'
      : 'Архів порожній — немає вимкнених тегів.';

  return (
    <Box sx={{ pb: 1 }}>
      <Stack spacing={2}>
        {error != null ? <PowerAlert severity="error">{error}</PowerAlert> : null}

        {!hasAnyTags ? (
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

        {hasAnyTags ? (
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
                <Stack direction="row" alignItems="center" gap={2} flexWrap="wrap">
                  <Box sx={{ flex: 1, maxWidth: 320 }}>
                    <TagsSearchField />
                  </Box>
                  <ToggleButtonGroup
                    value={view}
                    exclusive
                    size="small"
                    color="primary"
                    onChange={(_event, value: TagsView | null) => {
                      if (value) setView(value);
                    }}
                    sx={{
                      flexShrink: 0,
                      borderRadius: 1,
                      '& .MuiToggleButton-root': {
                        textTransform: 'none',
                        px: 1.75,
                        py: 0.625,
                        fontSize: '0.875rem',
                        fontWeight: 600,
                        lineHeight: 1.25,
                        borderRadius: 0,
                      },
                      '& .MuiToggleButtonGroup-firstButton': {
                        borderTopLeftRadius: 8,
                        borderBottomLeftRadius: 8,
                      },
                      '& .MuiToggleButtonGroup-lastButton': {
                        borderTopRightRadius: 8,
                        borderBottomRightRadius: 8,
                      },
                    }}
                  >
                    <ToggleButton value="active">Активні</ToggleButton>
                    <ToggleButton value="archived">Архів</ToggleButton>
                  </ToggleButtonGroup>
                </Stack>
                <PowerButton variant="contained" onClick={openCreateDialog}>
                  Додати тег
                </PowerButton>
              </Stack>
              {isEmptyView ? (
                <SectionEmptyState message={emptyViewMessage} />
              ) : (
                <SettingsNeoTable
                  columns={columns}
                  data={visibleTags}
                  layoutMode="grid"
                  enableRowActions
                  renderRowActions={renderRowActions}
                  rowActionsColumnSize={ORGANISM_TAGS_ACTIONS_COLUMN_SIZE}
                />
              )}
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
                error={Boolean(formErrors.ord)}
                helperText={formErrors.ord || ' '}
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
    </Box>
  );
}
