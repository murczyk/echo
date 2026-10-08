import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  AttachmentAdminRsp,
  AttachmentSettings,
  DeviceDocumentAdminRsp,
  DeviceDocumentItem,
  DeviceDocumentSettings,
} from '../../../../Bindings';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import {
  getAttachmentsPage,
  retryAttachment,
  saveAttachmentSettings,
} from '../../services/api/attachments';
import { isAbortError } from '../../services/api/client';
import {
  getDeviceDocumentsPage,
  retryDeviceDocument,
  saveDeviceDocumentSettings,
} from '../../services/api/device-documents';

const PAGE_SIZE = 50;

export function useMessageDocuments() {
  const [page, setPage] = useState<AttachmentAdminRsp | null>(null);
  const [settings, setSettings] = useState<AttachmentSettings | null>(null);
  const [query, setQuery] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  // query that produced the currently shown rows; pagination must keep using it
  const submittedQuery = useRef('');
  const loadingMore = useRef(false);
  const { notify } = usePowerSnackbar();
  const fail = useCallback(
    (message: string, error: unknown) =>
      notify({ severity: 'error', message: `${message}: ${String(error)}` }),
    [notify],
  );

  const load = useCallback(
    async (cursor: string | null = null) => {
      if (cursor && loadingMore.current) return;
      const requestQuery = cursor ? submittedQuery.current : query;
      loadingMore.current = cursor !== null;
      try {
        const response = await getAttachmentsPage(requestQuery, cursor);
        submittedQuery.current = requestQuery;
        setHasMore(response.documents.length === PAGE_SIZE);
        setPage((current) =>
          cursor && current
            ? { ...response, documents: [...current.documents, ...response.documents] }
            : response,
        );
        setSettings((current) => (cursor && current ? current : response.settings));
      } catch (error) {
        fail('Не вдалося завантажити документи', error);
      } finally {
        loadingMore.current = false;
      }
    },
    [query, fail],
  );
  useEffect(() => {
    void load();
    // initial load only; later reloads are triggered by search
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useCallback(async () => {
    if (!settings) return;
    setBusy(true);
    try {
      setSettings(await saveAttachmentSettings(settings));
      notify({ severity: 'success', message: 'Налаштування збережено' });
    } catch (error) {
      fail('Не вдалося зберегти', error);
    } finally {
      setBusy(false);
    }
  }, [settings, notify, fail]);

  const retry = useCallback(
    async (mediaId: string) => {
      try {
        await retryAttachment(mediaId);
        await load();
      } catch (error) {
        fail('Не вдалося повторити обробку', error);
      }
    },
    [load, fail],
  );

  const lastId = page?.documents.at(-1)?.mediaId ?? null;
  const loadMore = hasMore && lastId ? () => load(lastId) : null;
  return { page, settings, setSettings, query, setQuery, busy, load, save, retry, loadMore };
}

export function useDeviceDocuments() {
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
      } catch (loadError) {
        if (!signal?.aborted && !isAbortError(loadError)) fail();
      }
    },
    [query, fail],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
    // initial load only; later reloads are triggered by search
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useCallback(async () => {
    if (!settings) return;
    setBusy(true);
    try {
      setSettings(await saveDeviceDocumentSettings(settings));
      notify({ severity: 'success', message: 'Налаштування збережено' });
    } catch {
      fail();
    } finally {
      setBusy(false);
    }
  }, [settings, notify, fail]);

  const retry = useCallback(
    async (document: DeviceDocumentItem) => {
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
    },
    [load, fail],
  );
  return { page, settings, setSettings, query, setQuery, error, busy, load, save, retry };
}
