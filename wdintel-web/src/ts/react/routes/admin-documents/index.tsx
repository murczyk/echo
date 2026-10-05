import { AttachmentDocumentDialog } from '../shared/message-card/attachment-preview/DocumentContentDialog';
import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import type { AttachmentAdminRsp, AttachmentSettings } from '../../../../Bindings';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import {
  getAttachmentsPage,
  retryAttachment,
  saveAttachmentSettings,
} from '../../services/api/attachments';

export function AdminDocumentsPage() {
  const [page, setPage] = useState<AttachmentAdminRsp | null>(null);
  const [settings, setSettings] = useState<AttachmentSettings | null>(null);
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();
  const load = useCallback(
    async (cursor: string | null = null) => {
      try {
        const response = await getAttachmentsPage(query, cursor);
        setPage(response);
        setSettings(response.settings);
      } catch (error) {
        notify({
          severity: 'error',
          message: `Не вдалося завантажити документи: ${String(error)}`,
        });
      }
    },
    [query, notify],
  );
  useEffect(() => {
    void load();
  }, []);
  async function save() {
    if (!settings) return;
    try {
      setSettings(await saveAttachmentSettings(settings));
      notify({ severity: 'success', message: 'Налаштування збережено' });
    } catch (error) {
      notify({ severity: 'error', message: `Не вдалося зберегти: ${String(error)}` });
    }
  }
  async function retry(mediaId: string) {
    try {
      await retryAttachment(mediaId);
      await load();
    } catch (error) {
      notify({ severity: 'error', message: `Не вдалося повторити обробку: ${String(error)}` });
    }
  }
  return (
    <Stack spacing={3}>
      <Typography variant="h4">Документи повідомлень</Typography>
      {settings && (
        <Stack spacing={2}>
          <FormControlLabel
            label="Індексація вкладень"
            control={
              <Switch
                checked={settings.enabled}
                onChange={(_, enabled) => setSettings({ ...settings, enabled })}
              />
            }
          />
          <FormControlLabel
            label="Автоматичні підсумки"
            control={
              <Switch
                checked={settings.summariesEnabled}
                onChange={(_, summariesEnabled) => setSettings({ ...settings, summariesEnabled })}
              />
            }
          />
          <FormControlLabel
            label="Пошук позицій у документах та OCR"
            control={
              <Switch
                checked={settings.positionsEnabled}
                onChange={(_, positionsEnabled) => setSettings({ ...settings, positionsEnabled })}
              />
            }
          />
          <TextField
            select
            label="Рушій підсумків"
            value={settings.aiEngineId ?? ''}
            onChange={(event) =>
              setSettings({ ...settings, aiEngineId: event.target.value || null })
            }
          >
            <MenuItem value="">Не обрано</MenuItem>
            {page?.engines.map((engine) => (
              <MenuItem key={engine.id} value={engine.id}>
                {engine.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="Рушій позицій"
            value={settings.positionEngineId ?? ''}
            onChange={(event) =>
              setSettings({ ...settings, positionEngineId: event.target.value || null })
            }
          >
            <MenuItem value="">Не обрано</MenuItem>
            {page?.engines.map((engine) => (
              <MenuItem key={engine.id} value={engine.id}>
                {engine.name}
              </MenuItem>
            ))}
          </TextField>
          <Typography>
            {settings.backfillComplete
              ? 'Історію вкладень додано до черги'
              : 'Історія додається до черги від нових до старих'}
          </Typography>
          <Button onClick={() => void save()}>Зберегти</Button>
        </Stack>
      )}
      <Typography>
        {page?.counts.map((count) => `${count.kind} / ${count.state}: ${count.count}`).join(' · ')}
      </Typography>
      <Stack direction="row" spacing={2}>
        <TextField
          label="Назва або вміст"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          onClick={() => {
            void load();
          }}
        >
          Пошук / оновити
        </Button>
      </Stack>
      {page?.documents.map((document) => (
        <section key={document.mediaId}>
          <Button onClick={() => setPreview(document.mediaId)}>{document.fileName}</Button>
          <Typography>
            {document.state} · {document.quality} · розділів: {document.chunkCount} · підсумок:{' '}
            {document.summaryState} · позиції: {document.positionState}
          </Typography>
          <Typography>{document.summary}</Typography>
          <Typography color="error">{document.lastError}</Typography>
          <Button onClick={() => void retry(document.mediaId)}>Повторити обробку</Button>
        </section>
      ))}
      {page && page.documents.length === 50 && (
        <Button onClick={() => void load(page.documents.at(-1)?.mediaId ?? null)}>
          Наступні документи
        </Button>
      )}
      {preview && <AttachmentDocumentDialog mediaId={preview} onClose={() => setPreview(null)} />}
    </Stack>
  );
}
