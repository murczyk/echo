import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  SavedFilterDuty,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
} from '../../../../Bindings';
import {
  getGroupInfosBatch,
  getLatestFrequencies,
  getLatestSenders,
  getPostsList,
  getTagsForDisplay,
  getUserSigintGroups,
  savedFiltersList,
} from '../../services/api/inbox';
import { fetchServerInfo } from '../../services/api/server-info';

export type GroupCatalogError =
  { kind: 'catalog'; message: string } | { kind: 'details'; message: string };

export function useRerDutyFilterOptions() {
  const [profiles, setProfiles] = useState<Record<string, SignalProfileEntry | null>>({});
  const [freqs, setFreqs] = useState<string[]>([]);
  const [freqsReady, setFreqsReady] = useState(false);
  const [postsList, setPostsList] = useState<string[]>([]);
  const [groupInfos, setGroupInfos] = useState<Record<string, SignalGroupEntry>>({});
  const [groupsList, setGroupsList] = useState<string[]>([]);
  const [tagsMap, setTagsMap] = useState<Record<number, Tag>>({});
  const [tagsOrder, setTagsOrder] = useState<number[]>([]);
  const [savedFilters, setSavedFilters] = useState<SavedFilterDuty[]>([]);
  const [selectedSavedIdByFeedId, setSelectedSavedIdByFeedId] = useState<
    Record<string, number | null>
  >({});
  const [saveFilterNameByFeedId, setSaveFilterNameByFeedId] = useState<Record<string, string>>({});
  const [reloadFreqsLoading, setReloadFreqsLoading] = useState(false);
  const [groupCatalogLoading, setGroupCatalogLoading] = useState(false);
  const [groupCatalogError, setGroupCatalogError] = useState<GroupCatalogError | null>(null);
  const [featureStrictNetworks, setFeatureStrictNetworks] = useState(false);
  const mountedRef = useRef(true);
  const groupRequestGenerationRef = useRef(0);
  const groupsListRef = useRef<string[]>([]);

  useEffect(() => {
    groupsListRef.current = groupsList;
  }, [groupsList]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reloadLatestFrequencies = useCallback(async () => {
    setReloadFreqsLoading(true);
    try {
      const list = await getLatestFrequencies();
      if (mountedRef.current) setFreqs(list);
    } finally {
      if (mountedRef.current) setReloadFreqsLoading(false);
    }
  }, []);

  const loadFilterOptions = useCallback(async () => {
    const [sendersResult, freqsResult, postsResult, tagsResult] = await Promise.allSettled([
      getLatestSenders(),
      getLatestFrequencies(),
      getPostsList(),
      getTagsForDisplay(),
    ]);
    if (sendersResult.status === 'fulfilled') {
      if (mountedRef.current) setProfiles(sendersResult.value.data ?? {});
    } else console.warn('loadFilterOptions: getLatestSenders failed', sendersResult.reason);
    if (freqsResult.status === 'fulfilled') {
      if (mountedRef.current) setFreqs(freqsResult.value);
    } else console.warn('loadFilterOptions: getLatestFrequencies failed', freqsResult.reason);
    if (mountedRef.current) setFreqsReady(true);
    if (postsResult.status === 'fulfilled') {
      if (mountedRef.current) setPostsList(postsResult.value);
    } else console.warn('loadFilterOptions: getPostsList failed', postsResult.reason);
    if (tagsResult.status === 'fulfilled') {
      if (mountedRef.current) {
        setTagsMap(tagsResult.value.tagsMap);
        setTagsOrder(tagsResult.value.tagsOrder);
      }
    } else console.warn('loadFilterOptions: getTagsForDisplay failed', tagsResult.reason);
    try {
      const saved = await savedFiltersList();
      if (mountedRef.current) setSavedFilters(saved);
    } catch (e) {
      console.warn('loadFilterOptions: savedFiltersList failed', e);
    }
    try {
      const serverInfo = await fetchServerInfo();
      if (mountedRef.current) setFeatureStrictNetworks(serverInfo.featureStrictNetworks);
    } catch (e) {
      console.warn('loadFilterOptions: fetchServerInfo failed', e);
    }
  }, []);

  const reloadGroupCatalog = useCallback(() => {
    const generation = ++groupRequestGenerationRef.current;
    setGroupCatalogLoading(true);
    setGroupCatalogError(null);
    const sinceDateInclusiveMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
    getUserSigintGroups(sinceDateInclusiveMs)
      .then(async (groupKeys) => {
        if (!mountedRef.current || generation !== groupRequestGenerationRef.current) return;
        const normalizedKeys = groupKeys.filter((key) => key.trim() !== '');
        setGroupsList((previous) => [...new Set([...previous, ...normalizedKeys])]);
        if (normalizedKeys.length === 0) return;
        try {
          const infos = await getGroupInfosBatch(normalizedKeys);
          if (!mountedRef.current || generation !== groupRequestGenerationRef.current) return;
          setGroupInfos((previous) => ({
            ...previous,
            ...Object.fromEntries(infos.map((info) => [info.masterKey, info])),
          }));
        } catch {
          if (!mountedRef.current || generation !== groupRequestGenerationRef.current) return;
          setGroupCatalogError({
            kind: 'details',
            message: 'Не вдалося завантажити назви деяких груп.',
          });
        }
      })
      .catch(() => {
        if (!mountedRef.current || generation !== groupRequestGenerationRef.current) return;
        setGroupCatalogError({
          kind: 'catalog',
          message:
            groupsListRef.current.length > 0
              ? 'Не вдалося завантажити повний список груп. Показано раніше доступні групи.'
              : 'Не вдалося завантажити список груп.',
        });
      })
      .finally(() => {
        if (mountedRef.current && generation === groupRequestGenerationRef.current)
          setGroupCatalogLoading(false);
      });
  }, []);

  const pruneSavedFilterUiState = useCallback((feedId: string) => {
    setSelectedSavedIdByFeedId((prev) => {
      if (!(feedId in prev)) return prev;
      const next = { ...prev };
      delete next[feedId];
      return next;
    });
    setSaveFilterNameByFeedId((prev) => {
      if (!(feedId in prev)) return prev;
      const next = { ...prev };
      delete next[feedId];
      return next;
    });
  }, []);

  useEffect(() => {
    loadFilterOptions();
  }, [loadFilterOptions]);

  useEffect(() => {
    reloadGroupCatalog();
    return () => {
      groupRequestGenerationRef.current += 1;
    };
  }, [reloadGroupCatalog]);

  return {
    profiles,
    setProfiles,
    freqs,
    freqsReady,
    postsList,
    groupInfos,
    setGroupInfos,
    groupsList,
    tagsMap,
    tagsOrder,
    savedFilters,
    setSavedFilters,
    selectedSavedIdByFeedId,
    setSelectedSavedIdByFeedId,
    saveFilterNameByFeedId,
    setSaveFilterNameByFeedId,
    pruneSavedFilterUiState,
    reloadFreqsLoading,
    reloadLatestFrequencies,
    groupCatalogLoading,
    groupCatalogError,
    reloadGroupCatalog,
    featureStrictNetworks,
  };
}
