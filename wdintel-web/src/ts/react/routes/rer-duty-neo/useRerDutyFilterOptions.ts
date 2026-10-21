import { useCallback, useEffect, useRef, useState } from 'react';

import type { SavedFilterDuty, SignalProfileEntry, Tag } from '../../../../Bindings';
import {
  getLatestFrequencies,
  getLatestSenders,
  getPostsList,
  getTagsForDisplay,
  savedFiltersList,
} from '../../services/api/inbox';
import { fetchServerInfo } from '../../services/api/server-info';
import { useSigintGroupCatalog } from '../../hooks/use-sigint-group-catalog';

export type { GroupCatalogError } from '../../hooks/use-sigint-group-catalog';

export function useRerDutyFilterOptions(radioFeaturesAllowed = true) {
  const [profiles, setProfiles] = useState<Record<string, SignalProfileEntry | null>>({});
  const [freqs, setFreqs] = useState<string[]>([]);
  const [freqsReady, setFreqsReady] = useState(false);
  const [postsList, setPostsList] = useState<string[]>([]);
  const groupCatalog = useSigintGroupCatalog();
  const [tagsMap, setTagsMap] = useState<Record<number, Tag>>({});
  const [tagsOrder, setTagsOrder] = useState<number[]>([]);
  const [savedFilters, setSavedFilters] = useState<SavedFilterDuty[]>([]);
  const [selectedSavedIdByFeedId, setSelectedSavedIdByFeedId] = useState<
    Record<string, number | null>
  >({});
  const [saveFilterNameByFeedId, setSaveFilterNameByFeedId] = useState<Record<string, string>>({});
  const [reloadFreqsLoading, setReloadFreqsLoading] = useState(false);
  const [featureStrictNetworks, setFeatureStrictNetworks] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reloadLatestFrequencies = useCallback(async () => {
    if (!radioFeaturesAllowed) return;
    setReloadFreqsLoading(true);
    try {
      const list = await getLatestFrequencies();
      if (mountedRef.current) {
        setFreqs(list);
        setFreqsReady(true);
      }
    } finally {
      if (mountedRef.current) setReloadFreqsLoading(false);
    }
  }, [radioFeaturesAllowed]);

  const loadFilterOptions = useCallback(async () => {
    const [sendersResult, freqsResult, postsResult, tagsResult] = await Promise.allSettled([
      getLatestSenders(),
      radioFeaturesAllowed ? getLatestFrequencies() : Promise.resolve([]),
      radioFeaturesAllowed ? getPostsList() : Promise.resolve([]),
      getTagsForDisplay(),
    ]);
    if (sendersResult.status === 'fulfilled') {
      if (mountedRef.current) setProfiles(sendersResult.value.data ?? {});
    } else console.warn('loadFilterOptions: getLatestSenders failed', sendersResult.reason);
    if (freqsResult.status === 'fulfilled') {
      if (mountedRef.current) {
        setFreqs(freqsResult.value);
        setFreqsReady(true);
      }
    } else console.warn('loadFilterOptions: getLatestFrequencies failed', freqsResult.reason);
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
  }, [radioFeaturesAllowed]);

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

  return {
    profiles,
    setProfiles,
    freqs,
    freqsReady,
    postsList,
    ...groupCatalog,
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
    featureStrictNetworks,
  };
}
