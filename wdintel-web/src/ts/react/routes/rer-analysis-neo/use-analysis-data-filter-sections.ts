import type { Network, SignalGroupEntry, SignalProfileEntry, Tag, Unit } from '../../../../Bindings';
import { useCallback, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { isNullOrUndefined } from '../../utils/misc';


import { buildAnalysisReq } from './helpers';
import { emptyOptions } from './use-analysis-data.shared';
import {
  buildAnalysisReqForFilterSection,
  filterSectionCacheKey,
  filterSectionsForInitialLoad,
  loadFilterSectionData,
} from './use-analysis-data.reload';
import { toErrorMessage } from './use-analysis-data.shared';
import type { AnalysisAorEntry, AnalysisFilterOptions, AnalysisFilterSectionId, AnalysisQueryState } from './types';

export function buildFilterSectionsToLoad(
  queryState: AnalysisQueryState,
  loadedSections: AnalysisFilterSectionId[],
  forceReload: boolean,
): AnalysisFilterSectionId[] {
  const sections = new Set(filterSectionsForInitialLoad(queryState));
  if (forceReload) {
    loadedSections.forEach((section) => sections.add(section));
  }
  return Array.from(sections);
}

export function resetFilterOptionsForForcedReload(prev: AnalysisFilterOptions): AnalysisFilterOptions {
  return {
    ...emptyOptions,
    freqs: prev.freqs,
    newFreqs: prev.newFreqs,
  };
}

type Params = {
  queryState: AnalysisQueryState;
  optionsFreqValues: string[];
  unitsMapRef: MutableRefObject<Record<number, Unit>>;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  setAorEntries: Dispatch<SetStateAction<AnalysisAorEntry[]>>;
  setGroupInfos: Dispatch<SetStateAction<Record<string, SignalGroupEntry>>>;
  setNetworkDisplayMap: Dispatch<SetStateAction<Record<number, string>>>;
  setNetworks: Dispatch<SetStateAction<Network[]>>;
  setOptions: Dispatch<SetStateAction<AnalysisFilterOptions>>;
  setProfiles: Dispatch<SetStateAction<Record<string, SignalProfileEntry | null>>>;
  setTagsMap: Dispatch<SetStateAction<Record<number, Tag>>>;
};

export function useAnalysisFilterSections({
  queryState,
  optionsFreqValues,
  unitsMapRef,
  onError,
  onUnauthorized,
  setAorEntries,
  setGroupInfos,
  setNetworkDisplayMap,
  setNetworks,
  setOptions,
  setProfiles,
  setTagsMap,
}: Params) {
  const filterSectionLoadVersionRef = useRef(0);
  const loadedFilterSectionKeyRef = useRef<Record<AnalysisFilterSectionId, string>>({} as Record<AnalysisFilterSectionId, string>);

  const invalidateFilterSectionLoads = useCallback(() => {
    filterSectionLoadVersionRef.current += 1;
    loadedFilterSectionKeyRef.current = {} as Record<AnalysisFilterSectionId, string>;
  }, []);

  const loadFilterSection = useCallback(
    async (section: AnalysisFilterSectionId) => {
      const analysisReq = buildAnalysisReq(queryState, optionsFreqValues);
      if (isNullOrUndefined(analysisReq)) return;
      const sectionAnalysisReq = buildAnalysisReqForFilterSection(section, analysisReq);
      const requestKey = filterSectionCacheKey(section, analysisReq);
      if (loadedFilterSectionKeyRef.current[section] === requestKey) return;

      const loadVersion = filterSectionLoadVersionRef.current;
      try {
        await loadFilterSectionData(section, {
          analysisReq: sectionAnalysisReq,
          loadVersion,
          loadVersionRef: filterSectionLoadVersionRef,
          setAorEntries,
          setGroupInfos,
          setNetworks,
          setNetworkDisplayMap,
          setOptions,
          setProfiles,
          setTagsMap,
          unitsMap: unitsMapRef.current,
        });
        if (loadVersion !== filterSectionLoadVersionRef.current) return;
        loadedFilterSectionKeyRef.current[section] = requestKey;
      } catch (loadError) {
        if (loadVersion !== filterSectionLoadVersionRef.current) return;
        if (!onUnauthorized(loadError)) {
          onError(toErrorMessage(loadError));
        }
      }
    },
    [
      onError,
      onUnauthorized,
      optionsFreqValues,
      queryState,
      setAorEntries,
      setGroupInfos,
      setNetworkDisplayMap,
      setNetworks,
      setOptions,
      setProfiles,
      setTagsMap,
      unitsMapRef,
    ],
  );

  const loadInitialFilterSections = useCallback(
    async (analysisReq: NonNullable<ReturnType<typeof buildAnalysisReq>>, forceReload = false) => {
      const previouslyLoadedSections = forceReload ? (Object.keys(loadedFilterSectionKeyRef.current) as AnalysisFilterSectionId[]) : [];
      if (forceReload) {
        // Reset loaded keys and clear non-frequency options, preserving freqs/newFreqs.
        // Previously loaded lazy sections are reloaded below for the new request.
        invalidateFilterSectionLoads();
        setOptions(resetFilterOptionsForForcedReload);
      }
      const sections = buildFilterSectionsToLoad(queryState, previouslyLoadedSections, forceReload);
      if (sections.length === 0) return;

      await Promise.all(
        sections.map(async (section) => {
          const sectionKey = filterSectionCacheKey(section, analysisReq);
          if (loadedFilterSectionKeyRef.current[section] === sectionKey) return;
          const loadVersion = filterSectionLoadVersionRef.current;
          try {
            await loadFilterSectionData(section, {
              analysisReq: buildAnalysisReqForFilterSection(section, analysisReq),
              loadVersion,
              loadVersionRef: filterSectionLoadVersionRef,
              setAorEntries,
              setGroupInfos,
              setNetworks,
              setNetworkDisplayMap,
              setOptions,
              setProfiles,
              setTagsMap,
              unitsMap: unitsMapRef.current,
            });
            if (loadVersion !== filterSectionLoadVersionRef.current) return;
            loadedFilterSectionKeyRef.current[section] = sectionKey;
          } catch (loadError) {
            if (loadVersion !== filterSectionLoadVersionRef.current) return;
            if (!onUnauthorized(loadError)) {
              onError(toErrorMessage(loadError));
            }
          }
        }),
      );
    },
    [
      invalidateFilterSectionLoads,
      onError,
      onUnauthorized,
      queryState,
      setAorEntries,
      setGroupInfos,
      setNetworkDisplayMap,
      setNetworks,
      setOptions,
      setProfiles,
      setTagsMap,
      unitsMapRef,
    ],
  );

  return {
    invalidateFilterSectionLoads,
    loadFilterSection,
    loadInitialFilterSections,
  };
}
