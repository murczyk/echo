import type { Network, SignalGroupEntry, SignalProfileEntry, Tag, Unit } from '../../../../Bindings';
import { useCallback, useRef, useState } from 'react';
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
import type {
  AnalysisAorEntry,
  AnalysisFilterOptions,
  AnalysisFilterSectionId,
  AnalysisFilterSectionLoadState,
  AnalysisQueryState,
} from './types';

const OPTION_FILTER_SECTIONS: AnalysisFilterSectionId[] = ['tags', 'aors', 'groups', 'senders', 'callsigns', 'units', 'locations', 'posts', 'networks', 'metadata'];
const GLOBAL_OPTION_QUERY_FIELDS: Array<keyof AnalysisQueryState> = [
  'fromDateTimeStr',
  'toDateTimeStr',
  'freqsSelected',
  'search',
  'includeOnlyNewFreqs',
  'adjacentFreqsRange',
  'orWithExtendedForm',
  'orBookmarked',
  'orImportant',
  'orWithCoords',
  'orWithoutCoords',
  'filterTagsOption',
  'withoutModelTags',
  'reportTagsOnlyThisUnit',
  'includePelengLocations',
  'unitsExactMatchOnly',
  'withoutNetwork',
];

const SECTION_QUERY_FIELDS: Array<{ field: keyof AnalysisQueryState; section: AnalysisFilterSectionId }> = [
  { field: 'tags', section: 'tags' },
  { field: 'aorsSelected', section: 'aors' },
  { field: 'groupsSelected', section: 'groups' },
  { field: 'sendersSelected', section: 'senders' },
  { field: 'callsignsSelected', section: 'callsigns' },
  { field: 'unitsSelected', section: 'units' },
  { field: 'locationsSelected', section: 'locations' },
  { field: 'postsSelected', section: 'posts' },
  { field: 'networksSelected', section: 'networks' },
  { field: 'metadataCc', section: 'metadata' },
  { field: 'metadataSender', section: 'metadata' },
  { field: 'metadataReceiver', section: 'metadata' },
  { field: 'metadataHash', section: 'metadata' },
  { field: 'onlyWithMetadata', section: 'metadata' },
  { field: 'withoutMetadata', section: 'metadata' },
];

export type FilterSectionLoadPlan =
  | {
      mode: 'targeted';
      sectionsToReload: AnalysisFilterSectionId[];
    }
  | {
      mode: 'full';
      sectionsToReload: AnalysisFilterSectionId[];
      selectedSections: AnalysisFilterSectionId[];
      loadedSections: AnalysisFilterSectionId[];
    };

export function buildFilterSectionsToLoad(plan: FilterSectionLoadPlan): AnalysisFilterSectionId[] {
  const sections = new Set<AnalysisFilterSectionId>(plan.sectionsToReload);
  if (plan.mode === 'full') {
    const loadedSections = new Set(plan.loadedSections);
    plan.selectedSections.forEach((section) => {
      if (!loadedSections.has(section)) {
        sections.add(section);
      }
    });
  }
  return Array.from(sections);
}

const EMPTY_SECTION_LOAD_STATES: Record<AnalysisFilterSectionId, AnalysisFilterSectionLoadState> = {
  tags: 'idle',
  aors: 'idle',
  groups: 'idle',
  senders: 'idle',
  callsigns: 'idle',
  units: 'idle',
  locations: 'idle',
  posts: 'idle',
  networks: 'idle',
  metadata: 'idle',
};

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

  SECTION_QUERY_FIELDS.forEach(({ field, section }) => {
    if (!(field in patch)) return;
    OPTION_FILTER_SECTIONS.forEach((candidateSection) => {
      if (candidateSection !== section) {
        invalidateSections.add(candidateSection);
      }
    });
  });

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
  setNetworks,
  setOptions,
  setProfiles,
  setTagsMap,
}: Params) {
  const filterSectionLoadVersionRef = useRef(0);
  const loadedFilterSectionKeyRef = useRef<Record<AnalysisFilterSectionId, string>>({} as Record<AnalysisFilterSectionId, string>);
  const reloadFilterSectionsRef = useRef<Set<AnalysisFilterSectionId>>(new Set());
  const hasTargetedFilterSectionInvalidationRef = useRef(false);
  const [filterSectionLoadStates, setFilterSectionLoadStates] = useState<Record<AnalysisFilterSectionId, AnalysisFilterSectionLoadState>>(
    EMPTY_SECTION_LOAD_STATES,
  );

  const setSectionLoadState = useCallback((section: AnalysisFilterSectionId, loadState: AnalysisFilterSectionLoadState) => {
    setFilterSectionLoadStates((current) => (current[section] === loadState ? current : { ...current, [section]: loadState }));
  }, []);

  const hasLoadedSection = useCallback((section: AnalysisFilterSectionId) => section in loadedFilterSectionKeyRef.current, []);

  const invalidateFilterSectionLoads = useCallback(() => {
    filterSectionLoadVersionRef.current += 1;
    loadedFilterSectionKeyRef.current = {} as Record<AnalysisFilterSectionId, string>;
    reloadFilterSectionsRef.current.clear();
    hasTargetedFilterSectionInvalidationRef.current = false;
    setFilterSectionLoadStates({ ...EMPTY_SECTION_LOAD_STATES });
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
      hasTargetedFilterSectionInvalidationRef.current = true;
      sectionsToInvalidate.forEach((section) => {
        if (hasLoadedSection(section) || filterSectionLoadStates[section] === 'loading') {
          reloadFilterSectionsRef.current.add(section);
          setSectionLoadState(section, 'stale');
        }
        delete loadedFilterSectionKeyRef.current[section];
      });
    },
    [filterSectionLoadStates, hasLoadedSection, invalidateFilterSectionLoads, setSectionLoadState],
  );

  const getLoadedFilterSections = useCallback(
    () => Object.keys(loadedFilterSectionKeyRef.current) as AnalysisFilterSectionId[],
    [],
  );

  const getReloadFilterSections = useCallback(
    () => (hasTargetedFilterSectionInvalidationRef.current ? Array.from(reloadFilterSectionsRef.current) : null),
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
      if (filterSectionLoadStates[section] !== 'stale') {
        setSectionLoadState(section, 'loading');
      }
      try {
        await loadFilterSectionData(section, {
          analysisReq: sectionAnalysisReq,
          loadVersion,
          loadVersionRef: filterSectionLoadVersionRef,
          setAorEntries,
          setGroupInfos,
          setNetworks,
          setOptions,
          setProfiles,
          setTagsMap,
          unitsMap: unitsMapRef.current,
        });
        if (loadVersion !== filterSectionLoadVersionRef.current) return;
        loadedFilterSectionKeyRef.current[section] = requestKey;
        reloadFilterSectionsRef.current.delete(section);
        setSectionLoadState(section, 'loaded');
      } catch (loadError) {
        if (loadVersion !== filterSectionLoadVersionRef.current) return;
        setSectionLoadState(section, 'error');
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
      setNetworks,
      setOptions,
      setProfiles,
      setTagsMap,
      unitsMapRef,
      filterSectionLoadStates,
      setSectionLoadState,
    ],
  );

  const loadInitialFilterSections = useCallback(
    async (
      analysisReq: NonNullable<ReturnType<typeof buildAnalysisReq>>,
      plan:
        | FilterSectionLoadPlan
        | {
            mode: 'initial';
            selectedSections: AnalysisFilterSectionId[];
          },
      networkStatsCache?: Map<string, ReturnType<typeof fetchAnalysisNetworks>>,
      signal?: AbortSignal,
    ) => {
      const targetedInvalidationVersion = hasTargetedFilterSectionInvalidationRef.current ? filterSectionLoadVersionRef.current : null;
      const sections = buildFilterSectionsToLoad(
        plan.mode === 'initial'
          ? {
              mode: 'full',
              sectionsToReload: filterSectionsForInitialLoad(queryState),
              loadedSections: [],
              selectedSections: plan.selectedSections,
            }
          : plan,
      );
      if (sections.length === 0) {
        if (targetedInvalidationVersion === filterSectionLoadVersionRef.current && reloadFilterSectionsRef.current.size === 0) {
          hasTargetedFilterSectionInvalidationRef.current = false;
          reloadFilterSectionsRef.current.clear();
        }
        return;
      }

      await Promise.all(
        sections.map(async (section) => {
          const sectionKey = filterSectionCacheKey(section, analysisReq);
          if (loadedFilterSectionKeyRef.current[section] === sectionKey) return;
          const loadVersion = filterSectionLoadVersionRef.current;
          if (filterSectionLoadStates[section] !== 'stale') {
            setSectionLoadState(section, 'loading');
          }
          try {
            await loadFilterSectionData(section, {
              analysisReq: buildAnalysisReqForFilterSection(section, analysisReq),
              loadVersion,
              loadVersionRef: filterSectionLoadVersionRef,
              signal,
              setAorEntries,
              setGroupInfos,
              setNetworks,
              setOptions,
              setProfiles,
              setTagsMap,
              networkStatsCache,
              unitsMap: unitsMapRef.current,
            });
            if (signal?.aborted || loadVersion !== filterSectionLoadVersionRef.current) return;
            loadedFilterSectionKeyRef.current[section] = sectionKey;
            reloadFilterSectionsRef.current.delete(section);
            setSectionLoadState(section, 'loaded');
          } catch (loadError) {
            if (signal?.aborted || loadVersion !== filterSectionLoadVersionRef.current) return;
            setSectionLoadState(section, 'error');
            if (!onUnauthorized(loadError)) {
              onError(toErrorMessage(loadError));
            }
          }
        }),
      );

      if (targetedInvalidationVersion === filterSectionLoadVersionRef.current && reloadFilterSectionsRef.current.size === 0) {
        hasTargetedFilterSectionInvalidationRef.current = false;
        reloadFilterSectionsRef.current.clear();
      }
    },
    [
      onError,
      onUnauthorized,
      queryState,
      setAorEntries,
      setGroupInfos,
      setNetworks,
      setOptions,
      setProfiles,
      setTagsMap,
      unitsMapRef,
      filterSectionLoadStates,
      setSectionLoadState,
    ],
  );

  return {
    filterSectionLoadStates,
    isFilterSectionLoading: (section: AnalysisFilterSectionId) => filterSectionLoadStates[section] === 'loading',
    isFilterSectionEmptyLoading: (section: AnalysisFilterSectionId, optionCount: number) =>
      optionCount === 0 && (filterSectionLoadStates[section] === 'loading' || filterSectionLoadStates[section] === 'stale'),
    isFilterSectionStale: (section: AnalysisFilterSectionId) => filterSectionLoadStates[section] === 'stale',
    getLoadedFilterSections,
    getReloadFilterSections,
    invalidateFilterSectionLoads,
    invalidateFilterSectionLoadsForPatch,
    loadFilterSection,
    loadInitialFilterSections,
  };
}
