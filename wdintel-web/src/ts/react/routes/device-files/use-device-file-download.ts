import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceFileContentRef } from '../../../../Bindings';
import { AUTH_UNAUTHORIZED_EVENT } from '../../auth-redirect';
import { FORCED_NAVIGATION_EVENT } from '../../../browser/navigation-guard';
import { useOptionalPowerSnackbar } from '../../components/PowerSnackbar';
import { HttpRequestError, isAbortError } from '../../services/api/client';
import { deviceFileContentUrl, getDeviceFileContentSize } from '../../services/api/devices';
import {
  withDevicePreviewDeadline,
  DEVICE_FILE_PREVIEW_ACCESS_TIMEOUT_MS,
} from '../../services/api/device-file-preview';
import { toDeviceFileLoadError } from './helpers';

function startNativeDownload(source: DeviceFileContentRef) {
  const link = document.createElement('a');
  link.href = deviceFileContentUrl(source.deviceId, source.fileId, source.revision);
  link.download = '';
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
  }
}

export function useDeviceFileDownload(
  source: DeviceFileContentRef | null,
  onDenied?: (error: unknown) => void,
) {
  const [downloading, setDownloading] = useState(false);
  const active = useRef<AbortController | null>(null);
  const key = source ? `${source.deviceId}/${source.fileId}/${source.revision}` : null;
  const selectedKey = useRef(key);
  selectedKey.current = key;
  const { notify } = useOptionalPowerSnackbar();
  const callbacks = useRef({ notify, onDenied });
  callbacks.current = { notify, onDenied };
  useEffect(() => {
    const cancel = () => {
      active.current?.abort();
      active.current = null;
      setDownloading(false);
    };
    cancel();
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, cancel);
    window.addEventListener(FORCED_NAVIGATION_EVENT, cancel);
    return () => {
      cancel();
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, cancel);
      window.removeEventListener(FORCED_NAVIGATION_EVENT, cancel);
    };
  }, [key]);

  const download = useCallback(async () => {
    if (!source || active.current || selectedKey.current !== key) return;
    const controller = new AbortController();
    active.current = controller;
    setDownloading(true);
    const current = () =>
      active.current === controller && !controller.signal.aborted && selectedKey.current === key;
    const request = <T>(operation: (signal: AbortSignal) => Promise<T>) =>
      withDevicePreviewDeadline(
        controller.signal,
        DEVICE_FILE_PREVIEW_ACCESS_TIMEOUT_MS,
        operation,
      );
    try {
      const href = deviceFileContentUrl(source.deviceId, source.fileId, source.revision);
      await request((signal) => getDeviceFileContentSize(href, { signal }));
      if (current()) startNativeDownload(source);
    } catch (error) {
      const unauthorized = error instanceof HttpRequestError && error.status === 401;
      if ((!current() && !unauthorized) || isAbortError(error)) return;
      const denied = error instanceof HttpRequestError && [401, 403].includes(error.status);
      if (denied && !unauthorized && callbacks.current.onDenied) callbacks.current.onDenied(error);
      else {
        callbacks.current.notify({
          severity: 'error',
          message: toDeviceFileLoadError(error, 'Помилка скачування файлу').message,
        });
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setDownloading(false);
      }
    }
  }, [key, source]);
  return { downloading, download };
}
