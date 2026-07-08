import {
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
import { useCallback, useEffect, useState } from 'react';

import type { TagAdmin, TagUpsertReq } from '../../../../../Bindings';
import { PowerButton } from '../../../components/PowerButton';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../../components/dialogStyles';
import { type TagFormState, emptyTagForm, formFromTag, parseOrdValue } from './types';

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

export function OrganismTagDialog({
  open,
  editingTag,
  saveInFlight,
  onClose,
  onSave,
}: {
  open: boolean;
  editingTag: TagAdmin | null;
  saveInFlight: boolean;
  onClose: () => void;
  onSave: (req: Omit<TagUpsertReq, 'ownerOrganismId'>) => Promise<boolean>;
}) {
  const [form, setForm] = useState<TagFormState>(emptyTagForm);
  const [labelTouched, setLabelTouched] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      setForm(editingTag ? formFromTag(editingTag) : emptyTagForm);
      setLabelTouched(false);
      setFormErrors({});
    }
  }, [open, editingTag]);

  const isLabelValid = form.label.trim().length > 0;
  const showLabelError = labelTouched && !isLabelValid;

  const handleSave = useCallback(async () => {
    const ordValue = parseOrdValue(form.ord);
    if (form.ord.trim() && ordValue === null) {
      setFormErrors({ ord: 'Некоректне число' });
      return;
    }
    setFormErrors({});

    const req: Omit<TagUpsertReq, 'ownerOrganismId'> = {
      label: form.label.trim(),
      extra: form.extra,
      ord: ordValue,
      enabled: form.enabled,
      isPalitra: form.isPalitra,
    };

    const success = await onSave(req);
    if (success) {
      onClose();
    }
  }, [form, onSave, onClose]);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
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
              onChange={(event) => setForm((current) => ({ ...current, ord: event.target.value }))}
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
              onToggle={() => setForm((current) => ({ ...current, isPalitra: !current.isPalitra }))}
            />
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
        <PowerButton variant="outlined" onClick={onClose} disabled={saveInFlight}>
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
  );
}
