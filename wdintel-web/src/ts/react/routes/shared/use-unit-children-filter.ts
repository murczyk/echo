import type { UnitHierarchyReq } from '../../../../Bindings';
import { useEffect, useRef, useState } from 'react';
import { getUnitHierarchy } from '../../services/api/units';
import {
  UNIT_CATALOG_CHANGED_EVENT,
  unitCatalogRevision,
} from '../../services/unit-catalog-events';
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

type HierarchyScope = Pick<UnitHierarchyReq, 'unitIds' | 'selectionValues'>;
const catalogs = new Map<string, HierarchyCatalog>();
const pendingCatalogs = new Map<string, Promise<HierarchyCatalog>>();
let cachedRevision = unitCatalogRevision();

function loadHierarchyCatalog(
  scopeKey: string,
  previous: HierarchyCatalog | null,
): Promise<HierarchyCatalog> {
  const revision = unitCatalogRevision();
  if (cachedRevision !== revision) {
    catalogs.clear();
    pendingCatalogs.clear();
    cachedRevision = revision;
  }
  const cached = catalogs.get(scopeKey);
  if (cached) return Promise.resolve(cached);
  const pending = pendingCatalogs.get(scopeKey);
  if (pending) return pending;
  const scope: HierarchyScope = JSON.parse(scopeKey);
  const empty = scope.unitIds?.length === 0 && scope.selectionValues?.length === 0;
  const request = (
    empty ? Promise.resolve(null) : getUnitHierarchy(previous?.revision ?? null, scope)
  )
    .then((response) => {
      if (revision !== unitCatalogRevision()) {
        throw new DOMException('Unit catalog changed', 'AbortError');
      }
      let catalog = previous;
      if (response || empty) {
        const tree = response ? readUnitHierarchyTree(response) : [];
        const hierarchy = indexUnitHierarchyTree(tree, response?.units ?? []);
        for (const selection of response?.selections ?? []) {
          hierarchy.children.set(
            selection.value,
            selection.unitIds.map((id) => `unit-id:${id}`),
          );
          hierarchy.exact.set(
            selection.value,
            selection.exactUnitIds.map((id) => `unit-id:${id}`),
          );
          if (!hierarchy.parents.some((parent) => parent.value === selection.value)) {
            hierarchy.parents.push({
              value: selection.value,
              label: selection.label,
              descendants: selection.unitIds.map((id) => `unit-id:${id}`),
            });
          }
        }
        catalog = { revision: response?.revision ?? '', hierarchy, tree };
      }
      if (!catalog) throw new Error('Сервер не повернув ієрархію підрозділів');
      catalogs.set(scopeKey, catalog);
      return catalog;
    })
    .finally(() => {
      if (pendingCatalogs.get(scopeKey) === request) pendingCatalogs.delete(scopeKey);
    });
  pendingCatalogs.set(scopeKey, request);
  return request;
}

export function useUnitHierarchyCatalog(
  needed: boolean,
  onError: (message: string) => void,
  scope?: Partial<HierarchyScope>,
) {
  const scopeKey = JSON.stringify({
    unitIds: scope?.unitIds == null ? null : [...new Set(scope.unitIds)].sort((a, b) => a - b),
    selectionValues: [...new Set(scope?.selectionValues ?? [])].sort(),
  });
  const [revision, setRevision] = useState(unitCatalogRevision);
  const [state, setState] = useState<{
    key: string;
    revision: number;
    catalog: HierarchyCatalog | null;
  } | null>(null);
  const previous = useRef(state);
  previous.current = state;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    const changed = () => setRevision(unitCatalogRevision());
    window.addEventListener(UNIT_CATALOG_CHANGED_EVENT, changed);
    return () => window.removeEventListener(UNIT_CATALOG_CHANGED_EVENT, changed);
  }, []);
  useEffect(() => {
    if (!needed) return;
    let cancelled = false;
    const catalog = previous.current?.key === scopeKey ? previous.current.catalog : null;
    loadHierarchyCatalog(scopeKey, catalog)
      .then((catalog) => {
        if (!cancelled) setState({ key: scopeKey, revision, catalog });
      })
      .catch((error: unknown) => {
        if (cancelled || revision !== unitCatalogRevision()) return;
        setState({ key: scopeKey, revision, catalog: null });
        onErrorRef.current(`Не вдалося завантажити ієрархію підрозділів: ${String(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [needed, scopeKey, revision]);
  const current = state?.key === scopeKey && state.revision === revision;
  const catalog = current ? state.catalog : null;
  return {
    hierarchy: catalog?.hierarchy ?? null,
    tree: catalog?.tree ?? null,
    loading: needed && !current,
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
