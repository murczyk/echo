import { useState, useEffect, useCallback, useRef } from 'react';

import type { SavedFilterDuty, SignalGroupEntry, SignalProfileEntry, Tag } from '../../../../Bindings';
import {
  getGroupInfosBatch,
  getLatestFrequencies,
  getLatestSenders,
  getPostsList,
  getTagsMapForDisplay,
  getUserSigintGroups,
  savedFiltersList,
} from '../../services/api/inbox';
import { fetchServerInfo } from '../../services/api/server-info';

export function useRerDutyFilterOptions() {
  const [profiles, setProfiles] = useState<Record<string, SignalProfileEntry | null>>({});
  const [freqs, setFreqs] = useState<string[]>([]);
  const [postsList, setPostsList] = useState<string[]>([]);
  const [groupInfos, setGroupInfos] = useState<Record<string, SignalGroupEntry>>({});
  const [groupsList, setGroupsList] = useState<string[]>([]);
  const [tagsMap, setTagsMap] = useState<Record<number, Tag>>({});
  const [savedFilters, setSavedFilters] = useState<SavedFilterDuty[]>([]);
  const [selectedSavedId, setSelectedSavedId] = useState<number | null>(null);
  const [saveFilterName, setSaveFilterName] = useState('');
  const [reloadFreqsLoading, setReloadFreqsLoading] = useState(false);
  const [featureStrictNetworks, setFeatureStrictNetworks] = useState(false);
  const mountedRef = useRef(true);

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
    const [sendersResult, freqsResult, postsResult, groupKeysResult, tagsResult] = await Promise.allSettled([
      getLatestSenders(),
      getLatestFrequencies(),
      getPostsList(),
      getUserSigintGroups(Date.now() - 2 * 24 * 60 * 60 * 1000),
      getTagsMapForDisplay(),
    ]);
    if (sendersResult.status === 'fulfilled') setProfiles(sendersResult.value.data ?? {});
    else console.warn('loadFilterOptions: getLatestSenders failed', sendersResult.reason);
    if (freqsResult.status === 'fulfilled') setFreqs(freqsResult.value);
    else console.warn('loadFilterOptions: getLatestFrequencies failed', freqsResult.reason);
    if (postsResult.status === 'fulfilled') setPostsList(postsResult.value);
    else console.warn('loadFilterOptions: getPostsList failed', postsResult.reason);
    if (groupKeysResult.status === 'fulfilled') {
      const groupKeys = groupKeysResult.value;
      if (groupKeys.length > 0) {
        try {
          const infos = await getGroupInfosBatch(groupKeys);
          const map: Record<string, SignalGroupEntry> = {};
          infos.forEach((g) => {
            map[g.masterKey] = g;
          });
          setGroupInfos(map);
          setGroupsList(groupKeys);
        } catch (e) {
          console.warn('loadFilterOptions: getGroupInfosBatch failed', e);
        }
      }
    } else console.warn('loadFilterOptions: getUserSigintGroups failed', groupKeysResult.reason);
    if (tagsResult.status === 'fulfilled') setTagsMap(tagsResult.value);
    else console.warn('loadFilterOptions: getTagsMapForDisplay failed', tagsResult.reason);
    try {
      const saved = await savedFiltersList();
      setSavedFilters(saved);
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

  useEffect(() => {
    loadFilterOptions();
  }, [loadFilterOptions]);

  return {
    profiles,
    setProfiles,
    freqs,
    postsList,
    groupInfos,
    setGroupInfos,
    groupsList,
    tagsMap,
    savedFilters,
    setSavedFilters,
    selectedSavedId,
    setSelectedSavedId,
    saveFilterName,
    setSaveFilterName,
    reloadFreqsLoading,
    reloadLatestFrequencies,
    featureStrictNetworks,
  };
}
