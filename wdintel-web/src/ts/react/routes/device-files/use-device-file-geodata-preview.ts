import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceFileGeodataPreviewRsp } from '../../../../Bindings';
import type { FilePreviewLifecycleProps } from '../shared/message-card/attachment-preview/file-preview-source';
import {
  deviceFileGeodataResultUrl,
  getDeviceFileGeodataStatus,
  prepareDeviceFileGeodata,
  retryDeviceFileGeodata,
} from '../../services/api/device-file-preview';
import { HttpRequestError, isAbortError } from '../../services/api/client';
import type { DeviceFilePreviewSource } from './use-device-file-preview';

type GeodataState = 'preparing' | 'waiting' | 'ready' | 'failed';
function checkedStatus(source: DeviceFilePreviewSource, status: DeviceFileGeodataPreviewRsp) {
  if (
    status.fileId !== source.fileId ||
    status.revision !== source.revision ||
    (status.status === 'ready' &&
      (!status.generation ||
        status.resultUrl !== deviceFileGeodataResultUrl(source, status.generation)))
  ) {
    throw new Error('Сервер повернув перегляд іншої версії файлу.');
  }
  return status;
}
export function useDeviceFileGeodataPreview(
  source: DeviceFilePreviewSource,
  lifecycle: FilePreviewLifecycleProps,
) {
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    status: DeviceFileGeodataPreviewRsp | null;
    state: GeodataState;
  }>({ key: source.key, status: null, state: 'preparing' });
  const [retrying, setRetrying] = useState(false);
  const [cooldownReady, setCooldownReady] = useState(true);
  const current = useRef<AbortController | null>(null);
  const retryPending = useRef(false);
  const selectedKey = useRef(source.key);
  selectedKey.current = source.key;
  const { signal, onError, isCurrent } = lifecycle;
  const refresh = useCallback(() => {
    current.current?.abort();
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    current.current = controller;
    retryPending.current = false;
    setRetrying(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cooldown: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const abort = () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(cooldown);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const active = () =>
      !controller.signal.aborted &&
      current.current === controller &&
      selectedKey.current === source.key &&
      isCurrent();
    setSnapshot({ key: source.key, status: null, state: 'preparing' });
    setCooldownReady(true);
    const poll = async () => {
      if (!active()) return;
      if (polls >= 60) {
        setSnapshot((previous) => ({ ...previous, state: 'waiting' }));
        return;
      }
      try {
        let status = checkedStatus(
          source,
          await getDeviceFileGeodataStatus(source, controller.signal),
        );
        if (!active()) return;
        polls += 1;
        if (status.status === 'idle')
          status = checkedStatus(source, await prepareDeviceFileGeodata(source, controller.signal));
        if (!active()) return;
        const state =
          status.status === 'ready' ? 'ready' : status.status === 'failed' ? 'failed' : 'preparing';
        setSnapshot({ key: source.key, status, state });
        if (state === 'preparing') timer = setTimeout(() => void poll(), 2000);
        else if (state === 'failed' && status.retryable && (status.retryAfterMs ?? 0) > 0) {
          setCooldownReady(false);
          cooldown = setTimeout(() => {
            if (active()) setCooldownReady(true);
          }, status.retryAfterMs!);
        }
      } catch (error) {
        if (active() && !isAbortError(error)) onError(error);
      }
    };
    void poll();
    return () => {
      abort();
      signal.removeEventListener('abort', abort);
      if (current.current === controller) current.current = null;
    };
  }, [
    source.key,
    source.deviceId,
    source.fileId,
    source.revision,
    attempt,
    signal,
    onError,
    isCurrent,
  ]);
  const status = snapshot.key === source.key ? snapshot.status : null;
  const canRetry = status?.status === 'failed' && status.retryable && cooldownReady;
  const retry = useCallback(async () => {
    const controller = current.current;
    if (
      !canRetry ||
      !status?.generation ||
      retryPending.current ||
      !controller ||
      controller.signal.aborted ||
      !isCurrent()
    )
      return;
    retryPending.current = true;
    setRetrying(true);
    try {
      checkedStatus(
        source,
        await retryDeviceFileGeodata(
          source,
          { expectedGeneration: status.generation },
          controller.signal,
        ),
      );
      if (!controller.signal.aborted && selectedKey.current === source.key && isCurrent())
        refresh();
    } catch (error) {
      if (!controller.signal.aborted && selectedKey.current === source.key && isCurrent()) {
        if (error instanceof HttpRequestError && error.status === 409) refresh();
        else if (!isAbortError(error)) onError(error);
      }
    } finally {
      if (current.current === controller) {
        retryPending.current = false;
        setRetrying(false);
      }
    }
  }, [
    source.key,
    source.deviceId,
    source.fileId,
    source.revision,
    status,
    canRetry,
    isCurrent,
    refresh,
    onError,
  ]);
  return {
    status,
    state: snapshot.key === source.key ? snapshot.state : ('preparing' as GeodataState),
    retrying,
    canRetry,
    refresh,
    retry,
  };
}
