import { useEffect, useRef, useState } from 'react';
import { getUnitHierarchy } from '../../services/api/units';
import { readUnitHierarchyTree, type TreeNode } from './unit-hierarchy';
import {
  aggregateUnitParentOptions,
  indexUnitHierarchyTree,
  type UnitCountOption,
  type UnitHierarchyIndex,
} from './unit-children-filter';

type HierarchyCatalog = {
  revision: string;
  hierarchy: UnitHierarchyIndex;
  tree: TreeNode[];
};

const UNIT_HIERARCHY_RECONCILE_MS = 60_000;
const pendingCatalogs = new Map<string | null, Promise<HierarchyCatalog>>();

function loadHierarchyCatalog(catalog: HierarchyCatalog | null): Promise<HierarchyCatalog> {
  const revision = catalog?.revision ?? null;
  const pending = pendingCatalogs.get(revision);
  if (pending) return pending;
  const request = getUnitHierarchy(revision)
    .then((response) => {
      if (response) {
        const tree = readUnitHierarchyTree(response);
        return {
          revision: response.revision,
          hierarchy: indexUnitHierarchyTree(tree, response.units),
          tree,
        };
      }
      if (!catalog) throw new Error('Сервер не повернув ієрархію підрозділів');
      return catalog;
    })
    .finally(() => {
      pendingCatalogs.delete(revision);
    });
  pendingCatalogs.set(revision, request);
  return request;
}

export function useUnitHierarchyCatalog(
  needed: boolean,
  onError: (message: string) => void,
  refreshKey?: unknown,
) {
  const [catalog, setCatalog] = useState<HierarchyCatalog | null>(null);
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const requestRef = useRef<Promise<HierarchyCatalog | null> | null>(null);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
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
      setFailed(false);
      setRefresh((value) => value + 1);
    };
    const reconcile = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const interval = setInterval(reconcile, UNIT_HIERARCHY_RECONCILE_MS);
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', reconcile);
    return () => {
      clearInterval(interval);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', reconcile);
    };
  }, [needed]);
  useEffect(() => {
    if (!needed) {
      setFailed(false);
      return;
    }
    if (failed) return;
    let cancelled = false;
    const load = () =>
      cancelled ? Promise.resolve(null) : loadHierarchyCatalog(catalogRef.current);
    const previousRequest = requestRef.current;
    const request = previousRequest ? previousRequest.catch(() => null).then(load) : load();
    requestRef.current = request;
    request
      .then((catalog) => {
        if (!cancelled && catalog) {
          catalogRef.current = catalog;
          setCatalog(catalog);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFailed(true);
        onErrorRef.current(`Не вдалося завантажити ієрархію підрозділів: ${String(error)}`);
      })
      .finally(() => {
        if (requestRef.current === request) requestRef.current = null;
      });
    return () => {
      cancelled = true;
    };
  }, [failed, refresh, needed, refreshKey]);
  return {
    hierarchy: catalog?.hierarchy ?? null,
    tree: catalog?.tree ?? null,
    loading: needed && catalog === null && !failed,
  };
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
