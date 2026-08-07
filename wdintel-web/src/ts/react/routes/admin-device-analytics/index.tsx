import AddIcon from '@mui/icons-material/Add';
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestoreOutlinedIcon from '@mui/icons-material/RestoreOutlined';
import {
  Box,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AdminAnalyticsTag, RuleExpression } from '../../../../Bindings';
import { PageErrorState } from '../../components/PageErrorState';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { PowerChip } from '../../components/PowerChip';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import {
  archiveAnalyticsTag,
  createAnalyticsTag,
  listAdminAnalyticsTags,
  restoreAnalyticsTag,
  saveAnalyticsTagRule,
  updateAnalyticsTag,
} from '../../services/api/device-analytics';
import { reanalyzeAll } from '../../services/api/devices';
import { RuleExpressionEditor } from './RuleExpressionEditor';
import { RuleTestPanel } from './RuleTestPanel';

type TagDraft = {
  persisted: AdminAnalyticsTag | null;
  name: string;
  ruleExpression: RuleExpression | null;
};

const dateTimeFormatter = new Intl.DateTimeFormat('uk-UA', {
  dateStyle: 'short',
  timeStyle: 'short',
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}

function upsertTag(tags: AdminAnalyticsTag[], tag: AdminAnalyticsTag): AdminAnalyticsTag[] {
  const existingIndex = tags.findIndex((candidate) => candidate.id === tag.id);
  if (existingIndex === -1)
    return [...tags, tag].sort((left, right) => left.name.localeCompare(right.name, 'uk'));
  return tags.map((candidate) => (candidate.id === tag.id ? tag : candidate));
}

function draftIsDirty(draft: TagDraft): boolean {
  if (draft.persisted === null) return draft.name.trim() !== '' || draft.ruleExpression !== null;
  return (
    draft.name !== draft.persisted.name ||
    JSON.stringify(draft.ruleExpression) !== JSON.stringify(draft.persisted.ruleExpression)
  );
}

function TagEditorDialog({
  draft,
  saving,
  mutating,
  saveError,
  onChange,
  onClose,
  onSave,
  onToggleArchived,
}: {
  draft: TagDraft | null;
  saving: boolean;
  mutating: boolean;
  saveError: string | null;
  onChange: (draft: TagDraft) => void;
  onClose: () => void;
  onSave: () => void;
  onToggleArchived: () => void;
}) {
  if (draft === null) return null;
  const archived = draft.persisted?.archivedAt !== null && draft.persisted !== null;

  return (
    <Dialog
      open
      fullWidth
      maxWidth="md"
      onClose={saving || mutating ? undefined : onClose}
      aria-labelledby="tag-editor-title"
    >
      <DialogTitle id="tag-editor-title">
        {draft.persisted === null
          ? 'Новий тег пристроїв'
          : `Редагування тегу «${draft.persisted.name}»`}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <TextField
            label="Назва тегу"
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            required
            disabled={saving || mutating || archived}
            autoFocus
            inputProps={{ maxLength: 128 }}
            helperText="Назва повинна бути унікальною серед активних і архівних тегів."
            fullWidth
          />

          {archived ? (
            <PowerAlert severity="warning" autoHideDuration={null} dismissible={false}>
              Архівний тег спочатку потрібно відновити, щоб змінити назву або правило.
            </PowerAlert>
          ) : (
            <>
              <Box component="section" aria-labelledby="tag-rule-editor-title">
                <Typography id="tag-rule-editor-title" variant="h6" gutterBottom>
                  Активне правило
                </Typography>
                <RuleExpressionEditor
                  expression={draft.ruleExpression}
                  onChange={(ruleExpression) => onChange({ ...draft, ruleExpression })}
                />
              </Box>

              <RuleTestPanel
                tagId={draft.persisted?.id ?? null}
                expression={draft.ruleExpression}
              />
            </>
          )}
          {saveError ? (
            <PowerAlert severity="error" autoHideDuration={null} dismissible={false}>
              {saveError}
            </PowerAlert>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions
        sx={{
          px: { xs: 1, sm: 3 },
          py: 2,
          flexWrap: 'wrap',
          gap: 1,
          '& > :not(style) ~ :not(style)': { ml: 0 },
        }}
      >
        {draft.persisted !== null ? (
          <PowerButton
            key={archived ? 'restore' : 'archive'}
            color={archived ? 'primary' : 'warning'}
            variant="outlined"
            disabled={saving || mutating}
            onClick={onToggleArchived}
            sx={{ width: { xs: '100%', sm: 'auto' }, mr: { sm: 'auto' } }}
          >
            {mutating ? 'Змінюємо стан…' : archived ? 'Відновити тег' : 'Архівувати тег'}
          </PowerButton>
        ) : null}
        <PowerButton onClick={onClose} disabled={saving || mutating}>
          Скасувати
        </PowerButton>
        <PowerButton
          variant="contained"
          disabled={saving || mutating || archived || draft.name.trim() === ''}
          startIcon={saving ? <CircularProgress size={18} color="inherit" /> : undefined}
          onClick={onSave}
        >
          {saving ? 'Зберігаємо…' : 'Зберегти'}
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}

export function AdminDeviceAnalyticsPage() {
  const { notify } = usePowerSnackbar();
  const [tags, setTags] = useState<AdminAnalyticsTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<TagDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const rsp = await listAdminAnalyticsTags();
      setTags(rsp.tags);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sortedTags = useMemo(
    () =>
      [...tags].sort((left, right) => {
        const archiveOrder = Number(left.archivedAt !== null) - Number(right.archivedAt !== null);
        return archiveOrder || left.name.localeCompare(right.name, 'uk');
      }),
    [tags],
  );

  const closeEditor = () => {
    if (saving || draft === null) return;
    if (draftIsDirty(draft) && !window.confirm('Закрити редактор і втратити незбережені зміни?'))
      return;
    setDraft(null);
    setSaveError(null);
  };

  const saveDraft = async () => {
    if (draft === null) return;
    const name = draft.name.trim();
    if (name === '') return;

    setSaving(true);
    setSaveError(null);
    try {
      let persisted = draft.persisted;
      if (persisted === null) {
        persisted = await createAnalyticsTag({ name });
        setTags((current) => upsertTag(current, persisted as AdminAnalyticsTag));
        setDraft((current) => (current ? { ...current, persisted } : current));
      } else if (persisted.name !== name) {
        persisted = await updateAnalyticsTag({ id: persisted.id, name });
        setTags((current) => upsertTag(current, persisted as AdminAnalyticsTag));
        setDraft((current) => (current ? { ...current, persisted } : current));
      }

      const saved = await saveAnalyticsTagRule({
        id: persisted.id,
        ruleExpression: draft.ruleExpression,
      });
      setTags((current) => upsertTag(current, saved));
      setDraft(null);
      notify({ severity: 'success', message: 'Тег пристроїв і його активне правило збережено.' });
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const toggleArchived = async (tag: AdminAnalyticsTag): Promise<AdminAnalyticsTag | null> => {
    const action = tag.archivedAt === null ? 'архівувати' : 'відновити';
    if (!window.confirm(`Справді ${action} тег «${tag.name}»?`)) return null;

    setMutatingId(tag.id);
    try {
      const updated =
        tag.archivedAt === null
          ? await archiveAnalyticsTag({ id: tag.id })
          : await restoreAnalyticsTag({ id: tag.id });
      setTags((current) => upsertTag(current, updated));
      notify({
        severity: 'success',
        message: tag.archivedAt === null ? 'Тег архівовано.' : 'Тег відновлено.',
      });
      return updated;
    } catch (error) {
      notify({ severity: 'error', message: errorMessage(error) });
      return null;
    } finally {
      setMutatingId(null);
    }
  };

  const scheduleGlobalReanalysis = async () => {
    if (
      !window.confirm(
        'Позначити всі синхронізовані файли для повторного аналізу? Воркер обробить їх у фоновому режимі.',
      )
    ) {
      return;
    }

    setReanalyzing(true);
    try {
      const rsp = await reanalyzeAll();
      notify({
        severity: 'success',
        message: `Заплановано повторний аналіз ${rsp.scheduledFileCount.toLocaleString('uk-UA')} файлів.`,
      });
    } catch (error) {
      notify({ severity: 'error', message: errorMessage(error) });
    } finally {
      setReanalyzing(false);
    }
  };

  if (loadError !== null && tags.length === 0) {
    return (
      <PageErrorState
        message={`Не вдалося завантажити теги пристроїв: ${loadError}`}
        actionLabel="Спробувати ще раз"
        onAction={() => void load()}
      />
    );
  }

  return (
    <Box sx={{ width: '100%', minWidth: 0 }}>
      <Stack spacing={3}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          alignItems={{ md: 'center' }}
          justifyContent="space-between"
        >
          <Box>
            <Typography variant="h4" component="h1">
              Теги пристроїв
            </Typography>
            <Typography color="text.secondary">
              Динамічні теги призначаються за метаданими файла. Збережене правило застосовується до
              нових файлів; для старих запустіть повторний аналіз.
            </Typography>
          </Box>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <PowerButton
              variant="outlined"
              startIcon={
                reanalyzing ? <CircularProgress size={18} color="inherit" /> : <RefreshIcon />
              }
              disabled={reanalyzing || loading}
              onClick={() => void scheduleGlobalReanalysis()}
            >
              {reanalyzing ? 'Плануємо…' : 'Повторно проаналізувати всі файли'}
            </PowerButton>
            <PowerButton
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => {
                setSaveError(null);
                setDraft({ persisted: null, name: '', ruleExpression: null });
              }}
            >
              Створити тег
            </PowerButton>
          </Stack>
        </Stack>

        {loadError ? (
          <PowerAlert
            severity="warning"
            autoHideDuration={null}
            dismissible={false}
            action={
              <PowerButton color="inherit" size="small" onClick={() => void load()}>
                Повторити
              </PowerButton>
            }
          >
            {loadError}
          </PowerAlert>
        ) : null}

        <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table aria-label="Теги пристроїв" sx={{ minWidth: 840 }}>
            <TableHead>
              <TableRow>
                <TableCell>Назва</TableCell>
                <TableCell>Стан</TableCell>
                <TableCell>Правило</TableCell>
                <TableCell>Оновлено</TableCell>
                <TableCell align="right">Дії</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 6 }}>
                    <CircularProgress aria-label="Завантаження тегів пристроїв" />
                  </TableCell>
                </TableRow>
              ) : null}
              {!loading && sortedTags.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 6 }}>
                    <Typography color="text.secondary">
                      Каталог порожній. Створіть перший динамічний тег.
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : null}
              {!loading
                ? sortedTags.map((tag) => {
                    const archived = tag.archivedAt !== null;
                    const mutating = mutatingId === tag.id;
                    return (
                      <TableRow key={tag.id} hover>
                        <TableCell component="th" scope="row">
                          {tag.name}
                        </TableCell>
                        <TableCell>
                          <PowerChip
                            label={archived ? 'Архівний' : 'Активний'}
                            color={archived ? 'default' : 'success'}
                            selected={!archived}
                            interactive={false}
                          />
                        </TableCell>
                        <TableCell>
                          {tag.ruleExpression === null ? 'Немає' : 'Налаштоване'}
                        </TableCell>
                        <TableCell>{formatDateTime(tag.updatedAt)}</TableCell>
                        <TableCell align="right">
                          <Stack direction="row" spacing={1} justifyContent="flex-end">
                            <PowerButton
                              size="small"
                              variant="outlined"
                              startIcon={<EditOutlinedIcon />}
                              disabled={mutating}
                              onClick={() => {
                                setSaveError(null);
                                setDraft({
                                  persisted: tag,
                                  name: tag.name,
                                  ruleExpression: tag.ruleExpression,
                                });
                              }}
                            >
                              Редагувати
                            </PowerButton>
                            <PowerButton
                              key={archived ? 'restore' : 'archive'}
                              size="small"
                              color={archived ? 'primary' : 'warning'}
                              variant="outlined"
                              startIcon={
                                mutating ? (
                                  <CircularProgress size={16} color="inherit" />
                                ) : archived ? (
                                  <RestoreOutlinedIcon />
                                ) : (
                                  <ArchiveOutlinedIcon />
                                )
                              }
                              disabled={mutating}
                              onClick={() => void toggleArchived(tag)}
                            >
                              {archived ? 'Відновити' : 'Архівувати'}
                            </PowerButton>
                          </Stack>
                        </TableCell>
                      </TableRow>
                    );
                  })
                : null}
            </TableBody>
          </Table>
        </TableContainer>
      </Stack>

      <TagEditorDialog
        draft={draft}
        saving={saving}
        mutating={draft?.persisted?.id === mutatingId}
        saveError={saveError}
        onChange={setDraft}
        onClose={closeEditor}
        onSave={() => void saveDraft()}
        onToggleArchived={() => {
          if (draft?.persisted === null || draft?.persisted === undefined) return;
          const persisted = draft.persisted;
          void toggleArchived(persisted).then((updated) => {
            if (updated === null) return;
            setDraft((current) =>
              current?.persisted?.id === updated.id ? { ...current, persisted: updated } : current,
            );
          });
        }}
      />
    </Box>
  );
}
