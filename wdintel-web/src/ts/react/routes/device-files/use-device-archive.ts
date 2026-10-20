import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { DeviceArchiveStatus } from '../../../../Bindings';
import { AUTH_UNAUTHORIZED_EVENT } from '../../auth-redirect';
import { FORCED_NAVIGATION_EVENT } from '../../../browser/navigation-guard';
import { useOptionalPowerSnackbar } from '../../components/PowerSnackbar';
import { ensureDeviceArchive, getDeviceArchive } from '../../services/api/devices';
import { HttpRequestError, isAbortError } from '../../services/api/client';
import type { DeviceFileSelection } from './device-file-archive';
import { toDeviceFileLoadError } from './helpers';

const hidden = () => document.visibilityState === 'hidden';
export const DeviceArchiveActivityContext = createContext(true);

export function useDeviceArchive(deviceId: string, file: DeviceFileSelection, enabled: boolean) {
  enabled = useContext(DeviceArchiveActivityContext) && enabled;
  const key = `${deviceId}/${file.fileId}/${file.revision}`;
  const [snapshot, setSnapshot] = useState<{
    key: string;
    status: DeviceArchiveStatus | null;
    error: string | null;
    denied: boolean;
  }>({ key, status: null, error: null, denied: false });
  const [attempt, setAttempt] = useState(0);
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const nextPoll = useRef({ key, at: 0 });
  useEffect(() => {
    if (!enabled || !file.fileId || file.revision == null) return;
    if (nextPoll.current.key !== key) nextPoll.current = { key, at: 0 };
    let alive = true;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ensured = false;
    let pending = false;
    let lastError: string | null = null;
    let delay = 2000;
    const cancel = () => {
      alive = false;
      controller?.abort();
      clearTimeout(timer);
      setSnapshot({ key, status: null, error: 'Помилка доступу до архіву.', denied: true });
    };
    const load = async () => {
      if (!alive || hidden() || pending) return;
      const remaining = nextPoll.current.at - Date.now();
      if (remaining > 0) {
        timer = setTimeout(load, remaining);
        return;
      }
      pending = true;
      controller = new AbortController();
      let poll = true;
      try {
        let status = await getDeviceArchive(deviceId, file.fileId!, file.revision!, {
          signal: controller.signal,
        });
        if (!alive || controller.signal.aborted) return;
        if (
          status.source.deviceId !== deviceId ||
          status.source.fileId !== file.fileId ||
          status.source.revision !== file.revision
        )
          throw new Error('Отримано стан іншої ревізії архіву');
        if (status.archive.state === 'not_prepared' && !ensured) {
          status = await ensureDeviceArchive(deviceId, file.fileId!, file.revision!, {
            signal: controller.signal,
          });
          ensured = true;
        }
        if (!alive || controller.signal.aborted) return;
        if (
          status.source.deviceId !== deviceId ||
          status.source.fileId !== file.fileId ||
          status.source.revision !== file.revision
        )
          throw new Error('Отримано стан іншої ревізії архіву');
        setSnapshot({ key, status, error: null, denied: false });
        lastError = null;
        poll = ['missing_content', 'queued', 'running', 'retry_wait'].includes(
          status.archive.state,
        );
        delay = Math.max(2000, status.pollAfterMs);
      } catch (error) {
        if (!alive || isAbortError(error)) return;
        const message = toDeviceFileLoadError(error, 'Помилка перегляду архіву').message;
        const denied = error instanceof HttpRequestError && [401, 403, 404].includes(error.status);
        setSnapshot((previous) => ({
          key,
          status: denied || previous.key !== key ? null : previous.status,
          error: message,
          denied,
        }));
        if (message !== lastError) notifyRef.current({ severity: 'error', message });
        lastError = message;
        poll = !denied;
        delay = Math.max(
          2000,
          error instanceof HttpRequestError ? (error.retryAfterMs ?? 2000) : 2000,
        );
      } finally {
        pending = false;
        if (alive && poll) {
          nextPoll.current = { key, at: Date.now() + delay };
          if (!hidden()) timer = setTimeout(load, delay);
        }
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (hidden()) controller?.abort();
      else void load();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, cancel);
    window.addEventListener(FORCED_NAVIGATION_EVENT, cancel);
    void load();
    return () => {
      alive = false;
      controller?.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, cancel);
      window.removeEventListener(FORCED_NAVIGATION_EVENT, cancel);
    };
  }, [key, enabled, file.hasContent, attempt]);
  const current = snapshot.key === key ? snapshot : null;
  return {
    denied: current?.denied ?? false,
    status: current?.status ?? null,
    summary: current?.denied ? null : (current?.status?.archive ?? file.archive ?? null),
    error: current?.error ?? null,
    retry: () => setAttempt((value) => value + 1),
  };
}
