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

let pendingCatalog: Promise<HierarchyCatalog> | null = null;

function loadHierarchyCatalog(catalog: HierarchyCatalog | null): Promise<HierarchyCatalog> {
  if (pendingCatalog) return pendingCatalog;
  pendingCatalog = getUnitHierarchy(catalog?.revision ?? null)
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
      pendingCatalog = null;
    });
  return pendingCatalog;
}

export function useUnitHierarchyCatalog(
  needed: boolean,
  onError: (message: string) => void,
  refreshKey?: unknown,
) {
  const [catalog, setCatalog] = useState<HierarchyCatalog | null>(null);
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
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
    if (failed) return;
    let cancelled = false;
    loadHierarchyCatalog(catalogRef.current)
      .then((catalog) => {
        if (!cancelled) setCatalog(catalog);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFailed(true);
        onErrorRef.current(`Не вдалося завантажити ієрархію підрозділів: ${String(error)}`);
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
