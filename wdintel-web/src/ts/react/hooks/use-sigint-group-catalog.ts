import { useCallback, useEffect, useRef, useState } from 'react';

import type { SignalGroupEntry } from '../../../Bindings';
import { getGroupInfosBatch, getUserSigintGroups } from '../services/api/inbox';

export type GroupCatalogError =
  { kind: 'catalog'; message: string } | { kind: 'details'; message: string };

export function useSigintGroupCatalog() {
  const [groupInfos, setGroupInfos] = useState<Record<string, SignalGroupEntry>>({});
  const [groupsList, setGroupsList] = useState<string[]>([]);
  const [groupCatalogLoading, setGroupCatalogLoading] = useState(false);
  const [groupCatalogError, setGroupCatalogError] = useState<GroupCatalogError | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const groupsListRef = useRef(groupsList);
  groupsListRef.current = groupsList;

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
        try {
          const infos = await getGroupInfosBatch(normalizedKeys);
          if (!isCurrent()) return;
          setGroupInfos((previous) => ({
            ...previous,
            ...Object.fromEntries(infos.map((info) => [info.masterKey, info])),
          }));
        } catch {
          if (!isCurrent()) return;
          setGroupCatalogError({
            kind: 'details',
            message: 'Не вдалося завантажити назви деяких груп.',
          });
        }
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
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    reloadGroupCatalog();
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, [reloadGroupCatalog]);

  return {
    groupInfos,
    setGroupInfos,
    groupsList,
    groupCatalogLoading,
    groupCatalogError,
    reloadGroupCatalog,
  };
}
