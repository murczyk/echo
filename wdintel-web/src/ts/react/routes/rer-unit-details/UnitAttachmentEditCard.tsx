import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SaveIcon from '@mui/icons-material/Save';
import {
  Autocomplete,
  Button,
  Card,
  CardActions,
  CardContent,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import type { AreaOfResponsibility, UnitAttachment } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { listAors } from '../../services/api/aor';
import { updateUnitAttachment } from '../../services/api/units';
import { MAX_FULL_DESCRIPTION_CHARS, MAX_SHORT_DESCRIPTION_CHARS } from './UnitAttachmentUploader';

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Невідома помилка';
}

export function UnitAttachmentEditCard({
  attachment,
  onCancel,
  onSaved,
}: {
  attachment: UnitAttachment;
  onCancel: () => void;
  onSaved: (attachment: UnitAttachment) => void;
}) {
  const [shortDescription, setShortDescription] = useState(attachment.shortDescription);
  const [fullDescription, setFullDescription] = useState(attachment.fullDescription);
  const [selectedAorIds, setSelectedAorIds] = useState(
    () => new Set((attachment.aors ?? []).map(({ id }) => id)),
  );
  const [aors, setAors] = useState<AreaOfResponsibility[]>([]);
  const [loadVersion, setLoadVersion] = useState(0);
  const [loadingAors, setLoadingAors] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingAors(true);
    setLoadError(null);
    void listAors({ sortBy: 'AreaOfResponsibilityNameAsc' }, controller.signal)
      .then((loadedAors) => {
        setAors(loadedAors);
        setLoadingAors(false);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLoadError(formatError(error));
        setLoadingAors(false);
      });
    return () => controller.abort();
  }, [loadVersion]);

  const selectedAors = useMemo(
    () => aors.filter(({ id }) => selectedAorIds.has(id)),
    [aors, selectedAorIds],
  );
  const canSave =
    !saving &&
    !loadingAors &&
    loadError === null &&
    shortDescription.trim() !== '' &&
    fullDescription.trim() !== '' &&
    selectedAorIds.size > 0;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await updateUnitAttachment({
        attachmentId: attachment.id,
        shortDescription: shortDescription.trim(),
        fullDescription: fullDescription.trim(),
        aorIds: Array.from(selectedAorIds),
      });
      onSaved(updated);
    } catch (error) {
      setSaveError(formatError(error));
      setSaving(false);
    }
  }

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2.5}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Button
              startIcon={<ArrowBackIcon />}
              onClick={onCancel}
              disabled={saving}
              sx={{ flexShrink: 0 }}
            >
              До файлів
            </Button>
            <div>
              <Typography variant="h6" component="h2">
                Редагувати файл
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {attachment.fileName || `attachment-${attachment.id}`}
              </Typography>
            </div>
          </Stack>

          {loadError ? (
            <PowerAlert
              severity="error"
              autoHideDuration={null}
              action={
                <Button color="inherit" size="small" onClick={() => setLoadVersion((v) => v + 1)}>
                  Спробувати ще раз
                </Button>
              }
            >
              Не вдалося завантажити смуги: {loadError}
            </PowerAlert>
          ) : null}
          {saveError ? (
            <PowerAlert severity="error" autoHideDuration={null}>
              Не вдалося зберегти файл: {saveError}
            </PowerAlert>
          ) : null}

          <TextField
            label="Короткий опис"
            value={shortDescription}
            onChange={(event) => setShortDescription(event.target.value)}
            multiline
            minRows={3}
            required
            disabled={saving}
            inputProps={{ maxLength: MAX_SHORT_DESCRIPTION_CHARS }}
            fullWidth
          />
          <TextField
            label="Повний опис"
            value={fullDescription}
            onChange={(event) => setFullDescription(event.target.value)}
            multiline
            minRows={5}
            required
            disabled={saving}
            inputProps={{ maxLength: MAX_FULL_DESCRIPTION_CHARS }}
            fullWidth
          />
          <Autocomplete
            multiple
            options={aors}
            value={selectedAors}
            loading={loadingAors}
            disabled={saving || loadingAors || loadError !== null}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            getOptionLabel={(option) => option.name}
            onChange={(_, value) => setSelectedAorIds(new Set(value.map(({ id }) => id)))}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Смуги"
                required
                InputProps={{
                  ...params.InputProps,
                  endAdornment: (
                    <>
                      {loadingAors ? <CircularProgress color="inherit" size={20} /> : null}
                      {params.InputProps.endAdornment}
                    </>
                  ),
                }}
              />
            )}
          />
        </Stack>
      </CardContent>
      <CardActions sx={{ justifyContent: 'flex-end', px: 2, pb: 2 }}>
        <Button onClick={onCancel} disabled={saving}>
          Скасувати
        </Button>
        <Button
          variant="contained"
          startIcon={saving ? <CircularProgress color="inherit" size={16} /> : <SaveIcon />}
          disabled={!canSave}
          onClick={() => void save()}
        >
          Зберегти
        </Button>
      </CardActions>
    </Card>
  );
}
