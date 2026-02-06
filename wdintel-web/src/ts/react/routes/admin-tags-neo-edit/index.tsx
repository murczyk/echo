import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import {
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Checkbox as MuiCheckbox,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import React from 'react';

import {
  TagAdmin,
  TagKeyword,
  TagModelErrorFE,
  TagUpsertReq,
} from '../../../../Bindings';
import { Info } from '../../components/info';
import { Button } from '../../components/mui-customized/button';
import {
  createTag,
  deleteTagKeyword,
  getTagModelErrors,
  listTags,
  updateTag,
} from '../../services/api/tags';
import { navigateWithinSpa } from '../../utils/browser';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

type StatusMessage = { kind: 'error'; message: string } | null;

type TagFormState = {
  label: string;
  extra: boolean;
  ordInput: string;
  enabled: boolean;
};

const emptyForm: TagFormState = {
  label: '',
  extra: false,
  ordInput: '',
  enabled: true,
};

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

function parseOrdValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildUpsertRequest(form: TagFormState): {
  errors: Record<string, string>;
  req: TagUpsertReq | null;
} {
  const errors: Record<string, string> = {};
  const label = form.label.trim();
  if (!label) {
    errors.label = 'Заповніть назву';
  }

  const ordValue = parseOrdValue(form.ordInput);
  if (form.ordInput.trim() && ordValue === null) {
    errors.ord = 'Некоректне число';
  }

  if (Object.keys(errors).length > 0) {
    return { errors, req: null };
  }

  return {
    errors: {},
    req: {
      label,
      extra: form.extra ? true : null,
      ord: ordValue,
      enabled: form.enabled,
    },
  };
}

function applyTagToForm(tag: TagAdmin): TagFormState {
  return {
    label: tag.label,
    extra: tag.extra === true,
    ordInput: tag.ord === null ? '' : String(tag.ord),
    enabled: tag.enabled,
  };
}

function getBackToPath(): string {
  const params = new URLSearchParams(window.location.search);
  const backTo = params.get('backTo');
  if (!backTo) return '/admin/tags-neo';

  try {
    return decodeURIComponent(backTo);
  } catch (_) {
    return '/admin/tags-neo';
  }
}

function normalizeBackTo(backTo: string | null): string | null {
  if (!backTo) return null;
  try {
    return decodeURIComponent(backTo);
  } catch (_) {
    return backTo;
  }
}

function buildEditPath(tagId: number, backTo: string | null): string {
  const params = new URLSearchParams();
  params.set('id', String(tagId));
  const normalizedBackTo = normalizeBackTo(backTo);
  if (normalizedBackTo) {
    params.set('backTo', normalizedBackTo);
  }
  return `/admin/tags-neo/edit?${params.toString()}`;
}

function buildKeywordCreatePath(tagId: number, backTo: string | null): string {
  const params = new URLSearchParams();
  params.set('tagId', String(tagId));
  const normalizedBackTo = normalizeBackTo(backTo);
  if (normalizedBackTo) {
    params.set('backTo', normalizedBackTo);
  }
  return `/admin/tags-neo/keyword-edit?${params.toString()}`;
}

function buildKeywordEditPath(
  tagId: number,
  keywordId: number,
  backTo: string | null
): string {
  const params = new URLSearchParams();
  params.set('tagId', String(tagId));
  params.set('keywordId', String(keywordId));
  const normalizedBackTo = normalizeBackTo(backTo);
  if (normalizedBackTo) {
    params.set('backTo', normalizedBackTo);
  }
  return `/admin/tags-neo/keyword-edit?${params.toString()}`;
}

function FormField(props: {
  label: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1">
      <TextField
        label={props.label}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        fullWidth
        placeholder={props.placeholder}
        disabled={props.disabled}
        error={Boolean(props.error)}
        helperText={props.error || ' '}
      />
    </div>
  );
}

function TagForm(props: {
  form: TagFormState;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (next: TagFormState) => void;
}) {
  const update = (patch: Partial<TagFormState>) =>
    props.onChange({ ...props.form, ...patch });

  return (
    <div className="space-y-4">
      <FormField
        label="Назва *"
        value={props.form.label}
        onChange={(value) => update({ label: value })}
        error={props.errors.label}
        disabled={props.disabled}
      />
      <FormControlLabel
        control={
          <MuiCheckbox
            checked={props.form.extra}
            onChange={(event) => update({ extra: event.target.checked })}
            disabled={props.disabled}
          />
        }
        label="Додатковий тег"
      />
      <FormField
        label="Ord (опційно)"
        value={props.form.ordInput}
        onChange={(value) => update({ ordInput: value })}
        error={props.errors.ord}
        placeholder="напр., 10.5"
        disabled={props.disabled}
      />
      <FormControlLabel
        control={
          <MuiCheckbox
            checked={props.form.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
            disabled={props.disabled}
          />
        }
        label="Активний"
      />
    </div>
  );
}

function KeywordsTable(props: {
  keywords: TagKeyword[];
  deletingIds: Set<number>;
  onEdit: (keywordId: number) => void;
  onDelete: (keywordId: number) => void;
}) {
  if (props.keywords.length === 0) {
    return (
      <div className="text-muted-foreground text-sm">Немає ключових слів</div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="table table-sm align-middle">
        <thead>
          <tr>
            <th>Ключ</th>
            <th>Regex</th>
            <th>Форми</th>
            <th>Форми (негативні)</th>
            <th className="text-end">Дії</th>
          </tr>
        </thead>
        <tbody>
          {props.keywords.map((keyword) => {
            const deleting = props.deletingIds.has(keyword.tagKeywordId);
            return (
              <tr key={keyword.tagKeywordId}>
                <td>{keyword.keyword}</td>
                <td>{keyword.isRegex ? 'так' : 'ні'}</td>
                <td>{keyword.keywordForms.join(', ')}</td>
                <td>{keyword.keywordNegativeForms.join(', ')}</td>
                <td className="text-end">
                  <div className="flex gap-2 justify-end">
                    <Button
                      variant="outlined"
                      size="small"
                      onClick={() => props.onEdit(keyword.tagKeywordId)}
                    >
                      Редагувати
                    </Button>
                    <Button
                      variant="outlined"
                      color="error"
                      size="small"
                      onClick={() => props.onDelete(keyword.tagKeywordId)}
                      disabled={deleting}
                    >
                      {deleting ? 'Видалення...' : 'Видалити'}
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TagActions(props: {
  isNew: boolean;
  saving: boolean;
  onSave: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex gap-3">
      <Button variant="outlined" onClick={props.onBack} disabled={props.saving}>
        Повернутись
      </Button>
      <Button
        variant="contained"
        onClick={props.onSave}
        disabled={props.saving}
      >
        {props.isNew ? 'Створити' : 'Зберегти'}
      </Button>
    </div>
  );
}

function KeywordDeleteDialog(props: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  disabled: boolean;
}) {
  return (
    <Dialog open={props.open} onClose={props.onClose}>
      <DialogTitle>Підтвердження видалення</DialogTitle>
      <DialogContent>Видалити ключове слово?</DialogContent>
      <DialogActions>
        <Button variant="outlined" onClick={props.onClose}>
          Скасувати
        </Button>
        <Button
          variant="contained"
          color="error"
          onClick={props.onConfirm}
          disabled={props.disabled}
        >
          Видалити
        </Button>
      </DialogActions>
    </Dialog>
  );
}

type AdminTagsNeoEditPageProps = {
  tagId: string | null;
};

function AdminTagsNeoEditPageBody(props: AdminTagsNeoEditPageProps) {
  const [form, setForm] = React.useState<TagFormState>(emptyForm);
  const [keywords, setKeywords] = React.useState<TagKeyword[]>([]);
  const [keywordErrors, setKeywordErrors] = React.useState<TagModelErrorFE[]>(
    []
  );
  const [deletingIds, setDeletingIds] = React.useState<Set<number>>(new Set());
  const [status, setStatus] = React.useState<LoadingStatus>('idle');
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [tagId, setTagId] = React.useState<number | null>(null);
  const [formErrors, setFormErrors] = React.useState<Record<string, string>>(
    {}
  );
  const [actionStatus, setActionStatus] = React.useState<StatusMessage>(null);
  const [deleteKeywordId, setDeleteKeywordId] = React.useState<number | null>(
    null
  );
  const [tabIndex, setTabIndex] = React.useState(0);

  const backTo = React.useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('backTo');
  }, []);

  const isNew = !props.tagId;

  async function loadTag(tagIdValue: number) {
    setStatus('loading');
    setLoadError(null);
    try {
      const data = await listTags();
      const found = data.find((tag) => tag.tagId === tagIdValue);
      if (!found) {
        setStatus('error');
        setLoadError('Тег не знайдено');
        return;
      }
      setForm(applyTagToForm(found));
      setKeywords(found.keywords);
      setTagId(found.tagId);
      setStatus('success');
    } catch (err) {
      setStatus('error');
      setLoadError(formatErrorMessage(err));
    }
  }

  React.useEffect(() => {
    if (isNew) {
      setStatus('success');
      setForm(emptyForm);
      setKeywords([]);
      setTagId(null);
      return;
    }

    const parsedId = Number(props.tagId);
    if (!Number.isFinite(parsedId)) {
      setStatus('error');
      setLoadError('Некоректний id тегу');
      return;
    }

    loadTag(parsedId);
    loadTagModelErrors(parsedId);
  }, [props.tagId]);

  async function loadTagModelErrors(parsedId: number) {
    try {
      const errors = await getTagModelErrors(parsedId);
      setKeywordErrors(errors);
    } catch (err) {
      setKeywordErrors([]);
      setLoadError(formatErrorMessage(err));
    }
  }

  function navigateBack() {
    navigateWithinSpa(getBackToPath());
  }

  async function handleSave() {
    const { errors, req } = buildUpsertRequest(form);
    setFormErrors(errors);
    if (!req) return;

    setSaving(true);
    setActionStatus(null);
    try {
      if (isNew) {
        const created = await createTag(req);
        setForm(applyTagToForm(created));
        setKeywords(created.keywords);
        setTagId(created.tagId);
        navigateWithinSpa(buildEditPath(created.tagId, backTo));
      } else if (tagId !== null) {
        const updated = await updateTag(tagId, req);
        setForm(applyTagToForm(updated));
        setKeywords(updated.keywords);
        setTagId(updated.tagId);
      }
    } catch (err) {
      setActionStatus({
        kind: 'error',
        message: `Не вдалося зберегти тег: ${formatErrorMessage(err)}`,
      });
    } finally {
      setSaving(false);
    }
  }

  function navigateToKeywordCreate() {
    if (!tagId) {
      setActionStatus({ kind: 'error', message: 'Спочатку збережіть тег' });
      return;
    }
    navigateWithinSpa(
      buildKeywordCreatePath(
        tagId,
        window.location.href.replace(window.location.origin, '')
      )
    );
  }

  function navigateToKeywordEdit(keywordId: number) {
    if (!tagId) {
      setActionStatus({ kind: 'error', message: 'Спочатку збережіть тег' });
      return;
    }
    navigateWithinSpa(
      buildKeywordEditPath(
        tagId,
        keywordId,
        window.location.href.replace(window.location.origin, '')
      )
    );
  }

  async function handleDeleteKeyword() {
    if (!tagId || deleteKeywordId === null) return;
    setDeletingIds((prev) => new Set(prev).add(deleteKeywordId));
    try {
      await deleteTagKeyword(tagId, deleteKeywordId);
      setKeywords((prev) =>
        prev.filter((kw) => kw.tagKeywordId !== deleteKeywordId)
      );
    } catch (err) {
      setActionStatus({
        kind: 'error',
        message: `Не вдалося видалити ключове слово: ${formatErrorMessage(
          err
        )}`,
      });
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(deleteKeywordId);
        return next;
      });
      setDeleteKeywordId(null);
    }
  }

  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center py-12">
        <CircularProgress size={28} />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="space-y-4">
        <Button
          variant="outlined"
          startIcon={<ArrowBackIcon />}
          onClick={navigateBack}
        >
          Назад
        </Button>
        <div className="text-red-600">
          {loadError || 'Помилка завантаження'}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center">
      <div className="w-full md:max-w-screen-lg space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Typography variant="h5" className="!font-semibold">
              {isNew ? 'Створити тег' : 'Редагувати тег'}
            </Typography>
            <Typography variant="body2" className="text-muted-foreground">
              {isNew ? 'Додайте новий тег' : 'Оновіть параметри тегу'}
            </Typography>
          </div>
          <Button
            variant="outlined"
            startIcon={<ArrowBackIcon />}
            onClick={navigateBack}
          >
            Назад
          </Button>
        </div>

        <TagForm
          form={form}
          errors={formErrors}
          disabled={saving}
          onChange={setForm}
        />

        <TagActions
          isNew={isNew}
          saving={saving}
          onSave={handleSave}
          onBack={navigateBack}
        />

        <div className="space-y-3">
          <div className="flex justify-between">
            <Typography variant="h6" className="!font-semibold">
              Ключові слова та відмітки
            </Typography>
            <Button
              variant="contained"
              size="small"
              onClick={navigateToKeywordCreate}
              disabled={saving}
            >
              Створити ключове слово
            </Button>
          </div>

          <Tabs
            value={tabIndex}
            onChange={(_, value) => setTabIndex(value)}
            aria-label="Ключові слова та відмітки помилок"
          >
            <Tab
              label="Ключові слова"
              id="keywords-tab"
              aria-controls="keywords-pane"
            />
            <Tab
              label="Відмітки помилок"
              id="errors-tab"
              aria-controls="errors-pane"
            />
          </Tabs>

          <div
            id="keywords-pane"
            role="tabpanel"
            aria-labelledby="keywords-tab"
            hidden={tabIndex !== 0}
          >
            {tabIndex === 0 && (
              <>
                <KeywordsTable
                  keywords={keywords}
                  deletingIds={deletingIds}
                  onEdit={navigateToKeywordEdit}
                  onDelete={setDeleteKeywordId}
                />
              </>
            )}
          </div>

          <div
            id="errors-pane"
            role="tabpanel"
            aria-labelledby="errors-tab"
            hidden={tabIndex !== 1}
          >
            {tabIndex === 1 &&
              (keywordErrors.length > 0 ? (
                keywordErrors.map((error) => (
                  <div
                    key={error.id}
                    className="p-3 border border-gray-200 rounded-md mb-3 еext-muted-foreground whitespace-pre-wrap"
                    dangerouslySetInnerHTML={{ __html: error.body }}
                  />
                ))
              ) : (
                <p className="text-muted-foreground text-sm">
                  Немає відміток помилок
                </p>
              ))}
          </div>
        </div>

        {actionStatus?.kind === 'error' ? (
          <Info text={actionStatus.message} color="error" />
        ) : null}
      </div>

      <KeywordDeleteDialog
        open={deleteKeywordId !== null}
        onClose={() => setDeleteKeywordId(null)}
        onConfirm={handleDeleteKeyword}
        disabled={deleteKeywordId !== null && deletingIds.has(deleteKeywordId)}
      />
    </div>
  );
}

export function AdminTagsNeoEditPage(props: AdminTagsNeoEditPageProps) {
  return <AdminTagsNeoEditPageBody tagId={props.tagId} />;
}
