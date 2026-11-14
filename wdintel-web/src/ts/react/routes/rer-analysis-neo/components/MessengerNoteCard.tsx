import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { Stack, TextField, Typography } from '@mui/material';
import { useState } from 'react';

import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { PowerIconButton } from '../../../components/PowerIconButton';
import { NO_DATA_LABEL } from '../../../utils/misc';
import { toErrorMessage } from '../use-analysis-data.shared';
import { MessengerCard } from './MessengerCard';

type Props = {
  title: string;
  text: string | null | undefined;
  // Without it the card is read-only and shows no pencil.
  onSave?: (text: string) => Promise<void>;
  maxLength?: number;
};

export function MessengerNoteCard({ title, text, onSave, maxLength }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = draft !== null;

  const close = () => {
    setDraft(null);
    setError(null);
  };

  const save = async () => {
    if (draft === null || onSave == null) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setDraft(null);
    } catch (reason) {
      setError(toErrorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <MessengerCard
      title={title}
      action={
        onSave != null && !editing ? (
          <PowerIconButton
            size="small"
            aria-label="Редагувати"
            onClick={() => setDraft(text ?? '')}
          >
            <EditOutlinedIcon fontSize="small" />
          </PowerIconButton>
        ) : null
      }
    >
      {editing ? (
        <>
          <TextField
            multiline
            minRows={3}
            fullWidth
            autoFocus
            value={draft}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            inputProps={{ 'aria-label': title, maxLength }}
            helperText={maxLength == null ? undefined : `${draft.length}/${maxLength}`}
          />
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
          <Stack direction="row" justifyContent="flex-end" spacing={1}>
            <PowerButton size="small" variant="outlined" disabled={saving} onClick={close}>
              Скасувати
            </PowerButton>
            <PowerButton size="small" variant="contained" disabled={saving} onClick={save}>
              Зберегти
            </PowerButton>
          </Stack>
        </>
      ) : (
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
          {text ? text : NO_DATA_LABEL}
        </Typography>
      )}
    </MessengerCard>
  );
}
