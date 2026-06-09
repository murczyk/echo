import type { Network, SignalGroupEntry, SignalProfileEntry, Tag, Unit } from '../../../../Bindings';
import { useCallback, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { isNullOrUndefined } from '../../utils/misc';

import { fetchAnalysisNetworks } from '../../services/api/analysis';
import { buildAnalysisReq } from './helpers';
import {
  buildAnalysisReqForFilterSection,
  filterSectionCacheKey,
  filterSectionsForInitialLoad,
  loadFilterSectionData,
} from './use-analysis-data.reload';
import { toErrorMessage } from './use-analysis-data.shared';
import type { AnalysisAorEntry, AnalysisFilterOptions, AnalysisFilterSectionId, AnalysisQueryState } from './types';

const OPTION_FILTER_SECTIONS: AnalysisFilterSectionId[] = ['tags', 'aors', 'groups', 'senders', 'callsigns', 'units', 'locations', 'posts', 'networks', 'metadata'];
const GLOBAL_OPTION_QUERY_FIELDS: Array<keyof AnalysisQueryState> = [
  'fromDateTimeStr',
  'toDateTimeStr',
  'tags',
  'aorsSelected',
  'groupsSelected',
  'sendersSelected',
  'freqsSelected',
  'callsignsSelected',
  'unitsSelected',
  'locationsSelected',
  'postsSelected',
  'networksSelected',
  'withoutNetwork',
  'search',
  'includeOnlyNewFreqs',
  'adjacentFreqsRange',
  'orWithExtendedForm',
  'orBookmarked',
  'orImportant',
  'orWithCoords',
  'orWithoutCoords',
  'unitsExactMatchOnly',
  'metadataCc',
  'metadataSender',
  'metadataReceiver',
  'metadataHash',
  'onlyWithMetadata',
  'withoutMetadata',
];
const TAGS_ONLY_QUERY_FIELDS: Array<keyof AnalysisQueryState> = ['filterTagsOption', 'withoutModelTags', 'reportTagsOnlyThisUnit'];
const LOCATIONS_ONLY_QUERY_FIELDS: Array<keyof AnalysisQueryState> = ['includePelengLocations'];

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

export function filterSectionsToInvalidateForPatch(patch: Partial<AnalysisQueryState>): AnalysisFilterSectionId[] {
  if (Object.keys(patch).length === 0) {
    return [...OPTION_FILTER_SECTIONS];
  }

  const invalidateSections = new Set<AnalysisFilterSectionId>();

  const invalidateAllOptionSections = () => {
    OPTION_FILTER_SECTIONS.forEach((section) => invalidateSections.add(section));
  };

  if (GLOBAL_OPTION_QUERY_FIELDS.some((field) => field in patch)) {
    invalidateAllOptionSections();
  }

  if (TAGS_ONLY_QUERY_FIELDS.some((field) => field in patch)) {
    invalidateSections.add('tags');
  }

  if (LOCATIONS_ONLY_QUERY_FIELDS.some((field) => field in patch)) {
    invalidateSections.add('locations');
  }

  return Array.from(invalidateSections);
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
  const reloadFilterSectionsRef = useRef<Set<AnalysisFilterSectionId>>(new Set());

  const invalidateFilterSectionLoads = useCallback(() => {
    filterSectionLoadVersionRef.current += 1;
    loadedFilterSectionKeyRef.current = {} as Record<AnalysisFilterSectionId, string>;
    reloadFilterSectionsRef.current.clear();
  }, []);

  const invalidateFilterSectionLoadsForPatch = useCallback(
    (patch?: Partial<AnalysisQueryState>) => {
      if (patch == null) {
        invalidateFilterSectionLoads();
        return;
      }

      const sectionsToInvalidate = filterSectionsToInvalidateForPatch(patch);
      if (sectionsToInvalidate.length === 0) return;

      filterSectionLoadVersionRef.current += 1;
      sectionsToInvalidate.forEach((section) => {
        if (section in loadedFilterSectionKeyRef.current) {
          reloadFilterSectionsRef.current.add(section);
        }
        delete loadedFilterSectionKeyRef.current[section];
      });
    },
    [invalidateFilterSectionLoads],
  );

  const getLoadedFilterSections = useCallback(
    () => Object.keys(loadedFilterSectionKeyRef.current) as AnalysisFilterSectionId[],
    [],
  );

  const getReloadFilterSections = useCallback(
    () => Array.from(reloadFilterSectionsRef.current),
    [],
  );

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
        reloadFilterSectionsRef.current.delete(section);
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
    async (
      analysisReq: NonNullable<ReturnType<typeof buildAnalysisReq>>,
      forceReload = false,
      loadedSections: AnalysisFilterSectionId[] = [],
      networkStatsCache?: Map<string, ReturnType<typeof fetchAnalysisNetworks>>,
    ) => {
      const sections = buildFilterSectionsToLoad(queryState, loadedSections, forceReload);
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
              networkStatsCache,
              unitsMap: unitsMapRef.current,
            });
            if (loadVersion !== filterSectionLoadVersionRef.current) return;
            loadedFilterSectionKeyRef.current[section] = sectionKey;
            reloadFilterSectionsRef.current.delete(section);
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
    getLoadedFilterSections,
    getReloadFilterSections,
    invalidateFilterSectionLoads,
    invalidateFilterSectionLoadsForPatch,
    loadFilterSection,
    loadInitialFilterSections,
  };
}
