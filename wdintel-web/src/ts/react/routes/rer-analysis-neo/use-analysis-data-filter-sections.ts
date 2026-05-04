import type { Network, SignalGroupEntry, SignalProfileEntry, Tag, Unit } from '../../../../Bindings';
import { useCallback, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { buildAnalysisReq } from './helpers';
import {
  buildAnalysisReqForFilterSection,
  filterSectionCacheKey,
  filterSectionsForInitialLoad,
  loadFilterSectionData,
} from './use-analysis-data.reload';
import { toErrorMessage } from './use-analysis-data.shared';
import type { AnalysisAorEntry, AnalysisFilterOptions, AnalysisFilterSectionId, AnalysisQueryState } from './types';

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
      if ((analysisReq === null || analysisReq === undefined)) return;
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
    async (analysisReq: NonNullable<ReturnType<typeof buildAnalysisReq>>) => {
      const sections = filterSectionsForInitialLoad(queryState);
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
