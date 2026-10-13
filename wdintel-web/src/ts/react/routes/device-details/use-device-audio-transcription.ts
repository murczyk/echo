import { useEffect, useRef, useState } from 'react';
import type {
  DeviceAudioAutomaticTranscriptionSnapshot,
  DeviceAudioTranscriptionAvailability,
  DeviceAudioTranscriptionStatusRsp,
} from '../../../../Bindings';
import { AUTH_UNAUTHORIZED_EVENT } from '../../auth-redirect';
import { FORCED_NAVIGATION_EVENT } from '../../../browser/navigation-guard';
import { useOptionalPowerSnackbar } from '../../components/PowerSnackbar';
import { HttpRequestError, isAbortError } from '../../services/api/client';
import {
  getDeviceAudioTranscriptionStatus,
  retryDeviceAudioTranscription,
} from '../../services/api/device-audio';
import { formatDeviceErrorMessage } from '../devices/helpers';

type Status = {
  key: string;
  snapshot: DeviceAudioAutomaticTranscriptionSnapshot | null;
  availability: DeviceAudioTranscriptionAvailability | null;
  accessDenied: boolean;
  retrying: boolean;
};
const empty = (key: string): Status => ({
  key,
  snapshot: null,
  availability: null,
  accessDenied: false,
  retrying: false,
});

export function useDeviceAudioTranscription(
  deviceId: string,
  audioId: string | null,
  active: boolean,
  ready: boolean,
  merge: (
    snapshot: DeviceAudioAutomaticTranscriptionSnapshot | null,
    availability: DeviceAudioTranscriptionAvailability,
  ) => void,
  onDenied?: () => void,
) {
  const key = `${deviceId}:${audioId}:${active}`;
  const [status, setStatus] = useState(() => empty(key));
  const latest = useRef(status);
  const { notify } = useOptionalPowerSnackbar();
  const callbacks = useRef({ ready, merge, notify, onDenied });
  callbacks.current = { ready, merge, notify, onDenied };
  const actions = useRef({ refresh: () => {}, retry: () => {} });

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let refreshRequested = false;
    let retryRequested = false;
    let failures = 0;
    let notified = false;
    latest.current = empty(key);
    setStatus(latest.current);
    const update = (patch: Partial<Status>) => {
      latest.current = { ...latest.current, ...patch };
      setStatus(latest.current);
    };
    const stop = () => {
      controller.abort();
      clearTimeout(timer);
    };
    const apply = (result: DeviceAudioTranscriptionStatusRsp) => {
      update({
        snapshot: result.snapshot ?? latest.current.snapshot,
        availability: result.availability,
      });
      if (callbacks.current.ready)
        callbacks.current.merge(latest.current.snapshot, result.availability);
    };
    const poll = async () => {
      if (busy || controller.signal.aborted || !active || audioId === null) return;
      busy = true;
      clearTimeout(timer);
      refreshRequested = false;
      const retry = retryRequested;
      retryRequested = false;
      try {
        const result = retry
          ? await retryDeviceAudioTranscription(
              { deviceId, audioId },
              { signal: controller.signal },
            )
          : await getDeviceAudioTranscriptionStatus(
              { deviceId, audioId, knownVersion: latest.current.snapshot?.version ?? null },
              { signal: controller.signal },
            );
        if (controller.signal.aborted) return;
        apply(result);
        failures = 0;
        notified = false;
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        const denied = error instanceof HttpRequestError && [401, 403, 404].includes(error.status);
        if (denied) {
          update({ accessDenied: true });
          callbacks.current.onDenied?.();
          stop();
        }
        if (!notified || retry || denied) {
          callbacks.current.notify({
            severity: 'error',
            message: `Помилка транскрибації: ${formatDeviceErrorMessage(error)}`,
          });
          notified = true;
        }
        if (retry) refreshRequested = true;
        else failures += 1;
      } finally {
        busy = false;
        if (!controller.signal.aborted) {
          if (retry) update({ retrying: false });
          if (refreshRequested || retryRequested) void poll();
          else
            timer = setTimeout(
              () => void poll(),
              failures ? Math.min(1000 * 2 ** Math.min(failures, 4), 10000) : 1000,
            );
        }
      }
    };
    actions.current = {
      refresh: () => {
        refreshRequested = true;
        void poll();
      },
      retry: () => {
        if (
          controller.signal.aborted ||
          latest.current.retrying ||
          !latest.current.availability?.canRetry
        )
          return;
        update({ retrying: true });
        retryRequested = true;
        void poll();
      },
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, stop, true);
    window.addEventListener(FORCED_NAVIGATION_EVENT, stop, true);
    void poll();
    return () => {
      stop();
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, stop, true);
      window.removeEventListener(FORCED_NAVIGATION_EVENT, stop, true);
    };
  }, [deviceId, audioId, active, key]);

  useEffect(() => {
    if (ready && latest.current.key === key && latest.current.availability)
      callbacks.current.merge(latest.current.snapshot, latest.current.availability);
  }, [ready, key]);

  return {
    ...(status.key === key ? status : empty(key)),
    refresh: () => actions.current.refresh(),
    retry: () => actions.current.retry(),
  };
}
export type DeviceAudioTranscriptionState = ReturnType<typeof useDeviceAudioTranscription>;
