import { useCallback, useEffect, useRef, useState } from 'react';

import type { AnalyticsTag } from '../../../../Bindings';
import { redirectToLogin } from '../../auth-redirect';
import { isAbortError, isUnauthorizedError } from '../../services/api/client';
import { listAnalyticsTags } from '../../services/api/devices';
import { toDeviceFileLoadError } from './helpers';
import type { DeviceFileLoadError } from './types';

export type DeviceAnalyticsTagsState = {
  tags: AnalyticsTag[];
  loading: boolean;
  error: DeviceFileLoadError | null;
  reload: () => Promise<void>;
};

export function useDeviceAnalyticsTags({
  deviceId,
  enabled,
}: {
  deviceId: string;
  enabled: boolean;
}): DeviceAnalyticsTagsState {
  const [tags, setTags] = useState<AnalyticsTag[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<DeviceFileLoadError | null>(null);
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!enabled) return;
    const seq = ++requestSeqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);

    try {
      const rsp = await listAnalyticsTags({ deviceId }, { signal: controller.signal });
      if (requestSeqRef.current !== seq || controller.signal.aborted) return;
      setTags(rsp.tags);
    } catch (loadError) {
      if (requestSeqRef.current !== seq || controller.signal.aborted || isAbortError(loadError)) {
        return;
      }
      if (isUnauthorizedError(loadError)) {
        redirectToLogin();
        return;
      }
      setError(toDeviceFileLoadError(loadError, 'Помилка завантаження тегів'));
    } finally {
      if (requestSeqRef.current === seq) setLoading(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [deviceId, enabled]);

  useEffect(() => {
    requestSeqRef.current += 1;
    abortRef.current?.abort();
    setTags([]);
    setError(null);
    setLoading(enabled);
    if (enabled) void load();
    return () => abortRef.current?.abort();
  }, [deviceId, enabled, load]);

  return { tags, loading, error, reload: load };
}
