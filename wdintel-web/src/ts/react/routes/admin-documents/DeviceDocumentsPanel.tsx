import { useCallback, useEffect, useState } from 'react';
import { FormControlLabel, MenuItem, Switch, TextField } from '@mui/material';
import type { DeviceDocumentAdminRsp, DeviceDocumentSettings } from '../../../../Bindings';
import { PowerButton } from '../../components/PowerButton';
import { PowerAlert } from '../../components/PowerAlert';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import {
  getDeviceDocumentsPage,
  retryDeviceDocument,
  saveDeviceDocumentSettings,
} from '../../services/api/device-documents';
import { isAbortError } from '../../services/api/client';

export function DeviceDocumentsPanel() {
  const [page, setPage] = useState<DeviceDocumentAdminRsp | null>(null);
  const [settings, setSettings] = useState<DeviceDocumentSettings | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { notify } = usePowerSnackbar();
  const fail = useCallback(() => {
    const message = 'Не вдалося завантажити або змінити обробку файлів пристроїв';
    setError(message);
    notify({ severity: 'error', message });
  }, [notify]);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await getDeviceDocumentsPage(query, signal);
        if (signal?.aborted) return;
        setPage(response);
        setSettings(response.settings);
        setError(null);
      } catch (error) {
        if (!signal?.aborted && !isAbortError(error)) fail();
      }
    },
    [query, fail],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);
  async function save() {
    if (!settings) return;
    setBusy(true);
    try {
      setSettings(await saveDeviceDocumentSettings(settings));
    } catch {
      fail();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="flex flex-col gap-echo-md" aria-label="Документи пристроїв">
      <h2 className="text-echo-xl font-semibold">Документи пристроїв</h2>
      {error && <PowerAlert severity="error">{error}</PowerAlert>}
      {page && !page.available && (
        <PowerAlert severity="info">Файловий реєстр не підключено</PowerAlert>
      )}
      {settings && page?.available && (
        <>
          <FormControlLabel
            label="Індексація файлів пристроїв"
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
            label="Пошук позицій"
            control={
              <Switch
                checked={settings.positionsEnabled}
                onChange={(_, positionsEnabled) => setSettings({ ...settings, positionsEnabled })}
              />
            }
          />
          {(['aiEngineId', 'positionEngineId'] as const).map((key) => (
            <TextField
              key={key}
              select
              label={key === 'aiEngineId' ? 'Рушій підсумків' : 'Рушій позицій'}
              value={settings[key] ?? ''}
              onChange={(event) => setSettings({ ...settings, [key]: event.target.value || null })}
            >
              <MenuItem value="">Не обрано</MenuItem>
              {page.engines.map((engine) => (
                <MenuItem key={engine.id} value={engine.id}>
                  {engine.name}
                </MenuItem>
              ))}
            </TextField>
          ))}
          <PowerButton disabled={busy} onClick={() => void save()}>
            Зберегти
          </PowerButton>
          <p>
            {page.backfillComplete ? 'Історію додано до черги' : 'Історія додається до черги'} ·
            Додано: {page.discovered}
          </p>
          <p>
            {page.counts
              .map((count) => `${count.kind} / ${count.state}: ${count.count}`)
              .join(' · ')}
          </p>
          <TextField
            label="Назва або вміст файлу"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <PowerButton onClick={() => void load()}>Пошук / оновити</PowerButton>
          {page.documents.map((document) => (
            <article
              key={`${document.fileId}:${document.revision}`}
              className="flex flex-col gap-echo-sm"
            >
              <a href={document.citation}>{document.fileName}</a>
              <p>
                {document.state} · {document.summaryState} · {document.positionState}
              </p>
              <p>{document.summary}</p>
              {document.hasContent && (
                <PowerButton
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await retryDeviceDocument({
                        deviceId: document.deviceId,
                        fileId: document.fileId,
                        revision: document.revision,
                        extractionRevision: null,
                        section: null,
                      });
                      await load();
                    } catch {
                      fail();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Повторити обробку
                </PowerButton>
              )}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
