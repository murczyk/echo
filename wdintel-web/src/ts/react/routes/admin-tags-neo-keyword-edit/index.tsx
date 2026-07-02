import {
  CircularProgress,
  FormControlLabel,
  Checkbox as MuiCheckbox,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import { TagKeyword, TagKeywordAddReq } from '../../../../Bindings';
import { FormPageHeader } from '../../components/FormPageHeader';
import { FormPageLayout } from '../../components/FormPageLayout';
import { Info } from '../../components/info';
import { PageErrorState } from '../../components/PageErrorState';
import { PageLoadingState } from '../../components/PageLoadingState';
import { PowerButton } from '../../components/PowerButton';
import { addTagKeywords, listTags, updateTagKeyword } from '../../services/api/tags';
import { navigateWithinSpa } from '../../utils/browser';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

type StatusMessage = { kind: 'error'; message: string } | null;

type KeywordFormState = {
  keyword: string;
  keywordFormsInput: string;
  keywordNegativeFormsInput: string;
  isRegex: boolean;
};

const emptyForm: KeywordFormState = {
  keyword: '',
  keywordFormsInput: '',
  keywordNegativeFormsInput: '',
  isRegex: false,
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

function parseId(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function buildKeywordRequest(form: KeywordFormState): {
  errors: Record<string, string>;
  req: TagKeywordAddReq | null;
} {
  const errors: Record<string, string> = {};
  const keyword = form.keyword.trim();
  if (!keyword) {
    errors.keyword = 'Заповніть ключове слово';
  }

  if (Object.keys(errors).length > 0) {
    return { errors, req: null };
  }

  const keywordForms = splitLines(form.keywordFormsInput);
  const keywordNegativeForms = splitLines(form.keywordNegativeFormsInput);

  return {
    errors: {},
    req: {
      isRegex: form.isRegex,
      keyword,
      keywordForms: keywordForms.length > 0 ? keywordForms : null,
      keywordNegativeForms: keywordNegativeForms.length > 0 ? keywordNegativeForms : null,
    },
  };
}

function applyKeywordToForm(keyword: TagKeyword): KeywordFormState {
  return {
    keyword: keyword.keyword,
    keywordFormsInput: keyword.keywordForms.join('\n'),
    keywordNegativeFormsInput: keyword.keywordNegativeForms.join('\n'),
    isRegex: keyword.isRegex,
  };
}

function getBackToPath(defaultTagId: number | null): string {
  const params = new URLSearchParams(window.location.search);
  const backTo = params.get('backTo');
  if (backTo) {
    try {
      return decodeURIComponent(backTo);
    } catch (_) {
      return '/admin/tags-neo';
    }
  }

  if (defaultTagId) {
    return `/admin/tags-neo/edit?id=${defaultTagId}`;
  }

  return '/admin/tags-neo';
}

function getQueryParam(name: string): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

function KeywordForm(props: {
  form: KeywordFormState;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (next: KeywordFormState) => void;
}) {
  const update = (patch: Partial<KeywordFormState>) => props.onChange({ ...props.form, ...patch });

  return (
    <div className="space-y-4">
      <TextField
        label="Ключове слово *"
        value={props.form.keyword}
        onChange={(event) => update({ keyword: event.target.value })}
        fullWidth
        disabled={props.disabled}
        error={Boolean(props.errors.keyword)}
        helperText={props.errors.keyword || ' '}
      />
      <TextField
        label="Форми (по одному на рядок, опційно)"
        value={props.form.keywordFormsInput}
        onChange={(event) => update({ keywordFormsInput: event.target.value })}
        fullWidth
        multiline
        minRows={4}
        disabled={props.disabled}
      />
      <TextField
        label="Негативні форми (по одному на рядок, опційно)"
        value={props.form.keywordNegativeFormsInput}
        onChange={(event) => update({ keywordNegativeFormsInput: event.target.value })}
        fullWidth
        multiline
        minRows={4}
        disabled={props.disabled}
      />
      <FormControlLabel
        control={
          <MuiCheckbox
            checked={props.form.isRegex}
            onChange={(event) => update({ isRegex: event.target.checked })}
            disabled={props.disabled}
          />
        }
        label="Regex"
      />
    </div>
  );
}

function LoadingState() {
  return <PageLoadingState />;
}

function ErrorState(props: { error: string; onBack: () => void }) {
  return <PageErrorState message={props.error} actionLabel="Назад" onAction={props.onBack} />;
}

function FormHeader(props: { title: string; subtitle?: string | null; onBack: () => void }) {
  return <FormPageHeader title={props.title} subtitle={props.subtitle} onBack={props.onBack} />;
}

function FormActions(props: {
  saving: boolean;
  isNew: boolean;
  onSave: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex gap-3">
      <PowerButton variant="outlined" onClick={props.onBack} disabled={props.saving}>
        Повернутись
      </PowerButton>
      <PowerButton variant="contained" onClick={props.onSave} disabled={props.saving}>
        {props.isNew ? 'Створити' : 'Зберегти'}
      </PowerButton>
    </div>
  );
}

type AdminTagsNeoKeywordEditPageProps = {
  tagId: string | null;
  keywordId: string | null;
};

function AdminTagsNeoKeywordEditPageBody(props: AdminTagsNeoKeywordEditPageProps) {
  const [form, setForm] = useState<KeywordFormState>(emptyForm);
  const [status, setStatus] = useState<LoadingStatus>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [actionStatus, setActionStatus] = useState<StatusMessage>(null);
  const [tagLabel, setTagLabel] = useState<string | null>(null);
  const [tagId, setTagId] = useState<number | null>(null);
  const [keywordId, setKeywordId] = useState<number | null>(null);

  const resolvedTagId = useMemo(
    () => parseId(props.tagId) ?? parseId(getQueryParam('tagId')),
    [props.tagId],
  );
  const resolvedKeywordId = useMemo(
    () => parseId(props.keywordId) ?? parseId(getQueryParam('keywordId')),
    [props.keywordId],
  );

  const effectiveTagId = tagId ?? resolvedTagId;
  const effectiveKeywordId = keywordId ?? resolvedKeywordId;
  const isNew = effectiveKeywordId === null;

  async function loadTag(tagIdValue: number, keywordIdValue: number | null) {
    setStatus('loading');
    setLoadError(null);
    try {
      const tags = await listTags();
      const foundTag = tags.find((tag) => tag.tagId === tagIdValue);
      if (!foundTag) {
        setStatus('error');
        setLoadError('Тег не знайдено');
        return;
      }

      setTagLabel(foundTag.label);
      setTagId(foundTag.tagId);

      if (keywordIdValue === null) {
        setKeywordId(null);
        setForm(emptyForm);
        setStatus('success');
        return;
      }

      const keyword = foundTag.keywords.find((kw) => kw.tagKeywordId === keywordIdValue);
      if (!keyword) {
        setStatus('error');
        setLoadError('Ключове слово не знайдено');
        return;
      }

      setKeywordId(keyword.tagKeywordId);
      setForm(applyKeywordToForm(keyword));
      setStatus('success');
    } catch (err) {
      setStatus('error');
      setLoadError(formatErrorMessage(err));
    }
  }

  useEffect(() => {
    if (!resolvedTagId) {
      setStatus('error');
      setLoadError('Некоректний id тегу');
      return;
    }

    loadTag(resolvedTagId, resolvedKeywordId);
  }, [resolvedTagId, resolvedKeywordId]);

  function navigateBack() {
    navigateWithinSpa(getBackToPath(effectiveTagId));
  }

  async function handleSave() {
    const { errors, req } = buildKeywordRequest(form);
    setFormErrors(errors);
    if (!req) return;

    if (!effectiveTagId) {
      setActionStatus({ kind: 'error', message: 'Спочатку збережіть тег' });
      return;
    }

    setSaving(true);
    setActionStatus(null);
    try {
      if (isNew) {
        await addTagKeywords(effectiveTagId, [req]);
      } else if (effectiveKeywordId !== null) {
        await updateTagKeyword(effectiveTagId, effectiveKeywordId, req);
      }
      navigateWithinSpa(getBackToPath(effectiveTagId));
    } catch (err) {
      setActionStatus({
        kind: 'error',
        message: `Не вдалося зберегти ключове слово: ${formatErrorMessage(err)}`,
      });
    } finally {
      setSaving(false);
    }
  }

  if (status === 'loading') {
    return <LoadingState />;
  }

  if (status === 'error') {
    return <ErrorState error={loadError || 'Помилка завантаження'} onBack={navigateBack} />;
  }

  return (
    <FormPageLayout>
      <div className="w-full space-y-6">
        <FormHeader
          title={isNew ? 'Створити ключове слово' : 'Редагувати ключове слово'}
          subtitle={tagLabel ? `Тег: ${tagLabel}` : null}
          onBack={navigateBack}
        />

        <KeywordForm form={form} errors={formErrors} disabled={saving} onChange={setForm} />

        <FormActions saving={saving} isNew={isNew} onSave={handleSave} onBack={navigateBack} />

        {actionStatus?.kind === 'error' ? <Info text={actionStatus.message} color="error" /> : null}
      </div>
    </FormPageLayout>
  );
}

export function AdminTagsNeoKeywordEditPage(props: AdminTagsNeoKeywordEditPageProps) {
  return <AdminTagsNeoKeywordEditPageBody tagId={props.tagId} keywordId={props.keywordId} />;
}
