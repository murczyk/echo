import { useEffect, useRef, useState } from 'react';
import { getAllUnitsList } from '../../services/api/units';
import {
  aggregateUnitParentOptions,
  buildUnitHierarchyIndex,
  type UnitCountOption,
  type UnitHierarchyIndex,
} from './unit-children-filter';

export function useUnitHierarchyCatalog(needed: boolean, onError: (message: string) => void) {
  const [hierarchy, setHierarchy] = useState<UnitHierarchyIndex | null>(null);
  const [failed, setFailed] = useState(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    if (!needed || !failed) return;
    const timeout = setTimeout(() => setFailed(false), 2000);
    return () => clearTimeout(timeout);
  }, [failed, needed]);
  useEffect(() => {
    if (!needed) return;
    const refresh = () => {
      setHierarchy(null);
      setFailed(false);
    };
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [needed]);
  useEffect(() => {
    if (!needed) {
      setFailed(false);
      return;
    }
    if (hierarchy || failed) return;
    const controller = new AbortController();
    getAllUnitsList({ includeInactive: true, signal: controller.signal })
      .then((units) => {
        if (!controller.signal.aborted) setHierarchy(buildUnitHierarchyIndex(units));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFailed(true);
        onErrorRef.current(`Не вдалося завантажити ієрархію підрозділів: ${String(error)}`);
      });
    return () => controller.abort();
  }, [failed, hierarchy, needed]);
  return { hierarchy, loading: needed && hierarchy === null && !failed };
}

export function useUnitParentOptions(
  enabled: boolean,
  options: UnitCountOption[],
  hierarchy?: UnitHierarchyIndex | null,
) {
  const [aggregated, setAggregated] = useState<{
    source: UnitCountOption[];
    hierarchy: UnitHierarchyIndex;
    options: UnitCountOption[];
  } | null>(null);
  useEffect(() => {
    if (!enabled || !hierarchy) return;
    const timeout = setTimeout(() => {
      setAggregated({
        source: options,
        hierarchy,
        options: aggregateUnitParentOptions(options, hierarchy),
      });
    }, 0);
    return () => clearTimeout(timeout);
  }, [enabled, hierarchy, options]);
  const ready = aggregated?.source === options && aggregated?.hierarchy === hierarchy;
  return {
    options: enabled && ready ? aggregated.options : options,
    loading: enabled && hierarchy != null && !ready,
  };
}
