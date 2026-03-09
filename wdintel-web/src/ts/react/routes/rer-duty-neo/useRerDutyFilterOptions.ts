import React from 'react';

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

export function useRerDutyFilterOptions() {
  const [profiles, setProfiles] = React.useState<Record<string, SignalProfileEntry | null>>({});
  const [freqs, setFreqs] = React.useState<string[]>([]);
  const [postsList, setPostsList] = React.useState<string[]>([]);
  const [groupInfos, setGroupInfos] = React.useState<Record<string, SignalGroupEntry>>({});
  const [groupsList, setGroupsList] = React.useState<string[]>([]);
  const [tagsMap, setTagsMap] = React.useState<Record<number, Tag>>({});
  const [savedFilters, setSavedFilters] = React.useState<SavedFilterDuty[]>([]);
  const [selectedSavedId, setSelectedSavedId] = React.useState<number | null>(null);
  const [saveFilterName, setSaveFilterName] = React.useState('');
  const [reloadFreqsLoading, setReloadFreqsLoading] = React.useState(false);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reloadLatestFrequencies = React.useCallback(async () => {
    setReloadFreqsLoading(true);
    try {
      const list = await getLatestFrequencies();
      if (mountedRef.current) setFreqs(list);
    } finally {
      if (mountedRef.current) setReloadFreqsLoading(false);
    }
  }, []);

  const loadFilterOptions = React.useCallback(async () => {
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
  }, []);

  React.useEffect(() => {
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
  };
}
