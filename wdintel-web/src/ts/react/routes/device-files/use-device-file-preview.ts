import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeviceFileSelection } from './device-file-archive';
import { FORCED_NAVIGATION_EVENT } from '../../../browser/navigation-guard';
import { AUTH_UNAUTHORIZED_EVENT, emitUnauthorizedEvent } from '../../auth-redirect';
import { useOptionalPowerSnackbar } from '../../components/PowerSnackbar';
import { HttpRequestError, isAbortError } from '../../services/api/client';
import { deviceFileContentUrl } from '../../services/api/devices';
import { getDeviceFilePreviewContentSize } from '../../services/api/device-file-preview';
import { useDeviceFileDownload } from './use-device-file-download';
import {
  FilePreviewRenderError,
  normalizeFilePreviewMetadata,
  type FilePreviewSource,
} from '../shared/message-card/attachment-preview/file-preview-source';
import { toDeviceFileLoadError } from './helpers';

import { DEVICE_FILE_PREVIEW_MAX_BYTES } from './device-file-preview-config';

export type DeviceFilePreviewSource = FilePreviewSource & {
  deviceId: string;
  fileId: string;
  revision: number;
};

export type DeviceFilePreviewState =
  'idle' | 'loading' | 'ready' | 'empty' | 'unsupported' | 'transient-error' | 'denied';

type PreviewSession = {
  source: DeviceFilePreviewSource;
  epoch: number;
  controller: AbortController;
  cleanups: Set<() => void>;
  closed: boolean;
};

type PreviewSnapshot = {
  session: PreviewSession | null;
  state: DeviceFilePreviewState;
  error: string | null;
  sizeBytes: number | null;
  errorRetryable?: boolean;
  attempt: number;
};

export function deviceFilePreviewSource(
  deviceId: string,
  file: DeviceFileSelection | null,
): DeviceFilePreviewSource | null {
  if (file?.kind !== 'file' || !file.hasContent || !file.fileId || file.revision == null) {
    return null;
  }
  return {
    ...normalizeFilePreviewMetadata({
      fileName: file.name,
      extension: file.extension,
      contentType: file.mimeType,
    }),
    key: `${deviceId}/${file.fileId}/${file.revision}`,
    deviceId,
    fileId: file.fileId,
    revision: file.revision,
    sizeBytes: null,
    maxPreviewBytes: DEVICE_FILE_PREVIEW_MAX_BYTES,
    mediaHref: `${deviceFileContentUrl(deviceId, file.fileId, file.revision).replace(/\/content$/, '')}/preview/media`,
    originalHref: deviceFileContentUrl(deviceId, file.fileId, file.revision),
  };
}

function disposeSession(session: PreviewSession | null) {
  if (!session || session.closed) return;
  session.closed = true;
  session.controller.abort();
  for (const cleanup of session.cleanups) {
    try {
      cleanup();
    } catch {
      // A failed resource cleanup must not leave the rest of the session active.
    }
  }
  session.cleanups.clear();
}

function isDenied(error: unknown) {
  return error instanceof HttpRequestError && [401, 403, 404].includes(error.status);
}

export function useDeviceFilePreview({
  deviceId,
  file,
  enabled = true,
}: {
  deviceId: string;
  file: DeviceFileSelection | null;
  enabled?: boolean;
}) {
  const source = useMemo(
    () => (enabled ? deviceFilePreviewSource(deviceId, file) : null),
    [deviceId, file, enabled],
  );
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<PreviewSnapshot>({
    session: null,
    state: 'idle',
    error: null,
    sizeBytes: null,
    attempt: 0,
  });
  const current = useRef<PreviewSession | null>(null);
  const nextEpoch = useRef(0);
  const selectedKey = useRef(source?.key);
  selectedKey.current = source?.key;
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const sessionIsCurrent = useCallback(
    (session: PreviewSession | null) =>
      session !== null &&
      current.current === session &&
      !session.closed &&
      selectedKey.current === session.source.key,
    [],
  );

  const fail = useCallback(
    (session: PreviewSession, error: unknown, prefix = 'Помилка перегляду файлу') => {
      if (!sessionIsCurrent(session) || isAbortError(error)) return;
      const message = toDeviceFileLoadError(error, prefix).message;
      const denied = isDenied(error);
      if (denied) disposeSession(session);
      setSnapshot((previous) => ({
        ...previous,
        state: denied ? 'denied' : 'transient-error',
        error: message,
        errorRetryable:
          error instanceof FilePreviewRenderError
            ? error.retryable
            : !(error instanceof HttpRequestError && [413, 415].includes(error.status)),
      }));
      notifyRef.current({ severity: 'error', message });
      if (error instanceof HttpRequestError && error.status === 401) emitUnauthorizedEvent();
    },
    [sessionIsCurrent],
  );

  useEffect(() => {
    if (!source) {
      setSnapshot({ session: null, state: 'idle', error: null, sizeBytes: null, attempt });
      return;
    }
    const session: PreviewSession = {
      source,
      epoch: ++nextEpoch.current,
      controller: new AbortController(),
      cleanups: new Set(),
      closed: false,
    };
    current.current = session;
    setSnapshot({ session, state: 'loading', error: null, sizeBytes: null, attempt });
    void getDeviceFilePreviewContentSize(source.originalHref, session.controller.signal)
      .then(async (sizeBytes) => {
        if (!sessionIsCurrent(session)) return;
        setSnapshot({
          session,
          state: sizeBytes === 0 ? 'empty' : 'ready',
          error: null,
          sizeBytes,
          attempt,
        });
      })
      .catch((error: unknown) => fail(session, error, 'Помилка завантаження вмісту файлу'));
    return () => {
      disposeSession(session);
      if (current.current === session) current.current = null;
    };
  }, [
    source?.key,
    source?.fileName,
    source?.extension,
    source?.contentType,
    attempt,
    fail,
    sessionIsCurrent,
  ]);

  useEffect(() => {
    const cancel = () => {
      disposeSession(current.current);
      setSnapshot((previous) => ({
        ...previous,
        state: 'denied',
        error: 'Помилка доступу до файлу.',
      }));
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, cancel);
    window.addEventListener(FORCED_NAVIGATION_EVENT, cancel);
    return () => {
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, cancel);
      window.removeEventListener(FORCED_NAVIGATION_EVENT, cancel);
    };
  }, []);

  const matches = source?.key === snapshot.session?.source.key && attempt === snapshot.attempt;
  const session = matches ? snapshot.session : null;
  const state = !source ? 'idle' : matches ? snapshot.state : 'loading';
  const isCurrent = useCallback(() => sessionIsCurrent(session), [session, sessionIsCurrent]);
  const onError = useCallback(
    (error: unknown) => {
      if (session) fail(session, error);
    },
    [session, fail],
  );
  const registerCleanup = useCallback(
    (cleanup: () => void) => {
      if (!sessionIsCurrent(session)) {
        cleanup();
        return () => {};
      }
      session!.cleanups.add(cleanup);
      return () => {
        session!.cleanups.delete(cleanup);
      };
    },
    [session, sessionIsCurrent],
  );
  const retry = useCallback(() => {
    disposeSession(current.current);
    setAttempt((value) => value + 1);
  }, []);
  const checkAccess = useCallback(async () => {
    if (!sessionIsCurrent(session)) return false;
    try {
      await getDeviceFilePreviewContentSize(
        session!.source.originalHref,
        session!.controller.signal,
      );
      return sessionIsCurrent(session);
    } catch (error) {
      fail(session!, error);
      return false;
    }
  }, [session, sessionIsCurrent, fail]);
  const canDownload = !!source && matches && state !== 'loading' && state !== 'denied';
  const { downloading, download } = useDeviceFileDownload(canDownload ? source : null, onError);

  return {
    state,
    source:
      matches && session && state !== 'denied'
        ? { ...session.source, sizeBytes: snapshot.sizeBytes }
        : null,
    epoch: session?.epoch ?? null,
    signal: session?.controller.signal ?? null,
    error: matches ? snapshot.error : null,
    errorRetryable: snapshot.errorRetryable !== false,
    canDownload,
    downloading,
    download,
    retry,
    onError,
    registerCleanup,
    isCurrent,
    checkAccess,
  };
}
