import { useCallback, useEffect, useRef, useState } from 'react';

import type { SignalGroupEntry } from '../../../Bindings';
import { getGroupInfosBatch, getUserSigintGroups } from '../services/api/inbox';

export type GroupCatalogError =
  { kind: 'catalog'; message: string } | { kind: 'details'; message: string };

export function useSigintGroupCatalog() {
  const [groupInfos, setGroupInfos] = useState<Record<string, SignalGroupEntry>>({});
  const [groupsList, setGroupsList] = useState<string[]>([]);
  const [groupCatalogLoading, setGroupCatalogLoading] = useState(true);
  const [groupCatalogError, setGroupCatalogError] = useState<GroupCatalogError | null>(null);
  const [requiredGroupKeys, setRequiredGroupKeysState] = useState<string[]>([]);
  const [missingGroupInfosLoading, setMissingGroupInfosLoading] = useState(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const groupsListRef = useRef(groupsList);
  groupsListRef.current = groupsList;
  const groupInfosRef = useRef(groupInfos);
  groupInfosRef.current = groupInfos;

  const loadGroupInfos = useCallback(async (keys: string[], isCurrent: () => boolean) => {
    const requestedInfos = groupInfosRef.current;
    try {
      const infos = await getGroupInfosBatch(keys);
      if (!isCurrent()) return;
      setGroupInfos((previous) => {
        const updates = infos.filter(
          (info) => previous[info.masterKey] === requestedInfos[info.masterKey],
        );
        return updates.length === 0
          ? previous
          : { ...previous, ...Object.fromEntries(updates.map((info) => [info.masterKey, info])) };
      });
      setGroupCatalogError((previous) => (previous?.kind === 'details' ? null : previous));
    } catch {
      if (!isCurrent()) return;
      setGroupCatalogError({
        kind: 'details',
        message: 'Не вдалося завантажити назви деяких груп.',
      });
    }
  }, []);

  const setRequiredGroupKeys = useCallback((keys: readonly string[]) => {
    const next = [...new Set(keys.filter((key) => key.trim() !== ''))];
    setGroupsList((previous) => {
      const known = new Set(previous);
      const missing = next.filter((key) => !known.has(key));
      return missing.length === 0 ? previous : [...previous, ...missing];
    });
    setRequiredGroupKeysState((previous) =>
      previous.length === next.length && previous.every((key, index) => key === next[index])
        ? previous
        : next,
    );
  }, []);

  const reloadGroupCatalog = useCallback(() => {
    const generation = ++generationRef.current;
    const isCurrent = () => mountedRef.current && generation === generationRef.current;
    setGroupCatalogLoading(true);
    setGroupCatalogError(null);
    getUserSigintGroups(Date.now() - 2 * 24 * 60 * 60 * 1000)
      .then(async (keys) => {
        if (!isCurrent()) return;
        const normalizedKeys = keys.filter((key) => key.trim() !== '');
        setGroupsList((previous) => [...new Set([...previous, ...normalizedKeys])]);
        if (normalizedKeys.length === 0) return;
        await loadGroupInfos(normalizedKeys, isCurrent);
      })
      .catch(() => {
        if (!isCurrent()) return;
        setGroupCatalogError({
          kind: 'catalog',
          message:
            groupsListRef.current.length > 0
              ? 'Не вдалося завантажити повний список груп. Показано раніше доступні групи.'
              : 'Не вдалося завантажити список груп.',
        });
      })
      .finally(() => {
        if (isCurrent()) setGroupCatalogLoading(false);
      });
  }, [loadGroupInfos]);

  useEffect(() => {
    mountedRef.current = true;
    reloadGroupCatalog();
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, [reloadGroupCatalog]);

  useEffect(() => {
    const missingKeys = requiredGroupKeys.filter((key) => !groupInfosRef.current[key]);
    if (groupCatalogLoading || missingKeys.length === 0) {
      setMissingGroupInfosLoading(false);
      return;
    }
    let cancelled = false;
    const generation = generationRef.current;
    const isCurrent = () =>
      !cancelled && mountedRef.current && generation === generationRef.current;
    setMissingGroupInfosLoading(true);
    void loadGroupInfos(missingKeys, isCurrent).finally(() => {
      if (isCurrent()) setMissingGroupInfosLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [groupCatalogLoading, loadGroupInfos, requiredGroupKeys]);

  return {
    groupInfos,
    setGroupInfos,
    groupsList,
    groupCatalogLoading: groupCatalogLoading || missingGroupInfosLoading,
    groupCatalogError,
    reloadGroupCatalog,
    setRequiredGroupKeys,
  };
}
