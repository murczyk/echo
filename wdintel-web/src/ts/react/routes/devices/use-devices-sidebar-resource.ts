import { useCallback, useEffect, useRef, useState } from 'react';

import type { DeviceUnitStat, Unit } from '../../../../Bindings';
import { redirectToLogin } from '../../auth-redirect';
import { isAbortError, isUnauthorizedError } from '../../services/api/client';
import { getDeviceUnitStats, listDeviceUnits } from '../../services/api/devices';
import { formatDeviceErrorMessage } from './helpers';

export function useDevicesSidebarResource(enabled: boolean) {
  const [units, setUnits] = useState<Unit[]>([]);
  const [unitStats, setUnitStats] = useState<DeviceUnitStat[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (force = false) => {
      if (!enabled || (loaded && !force)) return;

      const seq = ++requestSeqRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);

      try {
        const [nextUnits, nextUnitStats] = await Promise.all([
          listDeviceUnits({ signal: controller.signal }),
          getDeviceUnitStats({ signal: controller.signal }),
        ]);
        if (requestSeqRef.current !== seq || controller.signal.aborted) return;

        setUnits(nextUnits);
        setUnitStats(nextUnitStats);
        setLoaded(true);
      } catch (loadError) {
        if (requestSeqRef.current !== seq || controller.signal.aborted || isAbortError(loadError)) {
          return;
        }
        if (isUnauthorizedError(loadError)) {
          redirectToLogin();
          return;
        }
        setError(
          `Помилка завантаження статистики підрозділів: ${formatDeviceErrorMessage(loadError)}`,
        );
      } finally {
        if (requestSeqRef.current === seq) setLoading(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [enabled, loaded],
  );

  useEffect(() => {
    if (enabled) void load();
    else setLoading(false);
  }, [enabled, load]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  return {
    units,
    unitStats,
    loading,
    loaded,
    error,
    reload: () => load(true),
  };
}
