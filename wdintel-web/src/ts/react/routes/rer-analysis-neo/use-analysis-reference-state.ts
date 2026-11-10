import { useEffect, useRef, useState } from 'react';

import type {
  CallsignInfoRes,
  Network,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
  Unit,
} from '../../../../Bindings';
import { buildNetworkDisplayMap } from './message-utils';
import type { AnalysisFilterOptions } from './types';
import { emptyOptions } from './use-analysis-data.shared';
import { createUnitLookupCache } from '../../services/unit-lookup-cache';
import { isAbortError } from '../../services/api/client';
import {
  UNIT_CATALOG_CHANGED_EVENT,
  unitCatalogRevision,
} from '../../services/unit-catalog-events';
import { toErrorMessage } from './use-analysis-data.shared';

type Params = {
  shouldLoadNewCallsigns: boolean;
  onError: (message: string) => void;
};

export function useAnalysisReferenceState({ shouldLoadNewCallsigns, onError }: Params) {
  const [loadUnitsByIds] = useState(createUnitLookupCache);
  const [options, setOptions] = useState<AnalysisFilterOptions>(emptyOptions);
  const [profiles, setProfiles] = useState<Record<string, SignalProfileEntry | null>>({});
  const [groupInfos, setGroupInfos] = useState<Record<string, SignalGroupEntry>>({});
  const [tagsMap, setTagsMap] = useState<Record<number, Tag>>({});
  const [tagsOrder, setTagsOrder] = useState<number[]>([]);
  const [networkDisplayMap, setNetworkDisplayMap] = useState<Record<number, string>>({});
  const [networks, setNetworks] = useState<Network[]>([]);
  const [summaryCallsignsInfo, setSummaryCallsignsInfo] = useState<Record<string, CallsignInfoRes>>(
    {},
  );
  const [unitsMap, setUnitsMap] = useState<Record<number, Unit>>({});
  const networksRef = useRef(networks);
  const summaryCallsignsInfoRef = useRef(summaryCallsignsInfo);
  const unitsMapRef = useRef(unitsMap);
  const optionsFreqsRef = useRef<string[]>([]);
  const shouldLoadNewCallsignsRef = useRef(shouldLoadNewCallsigns);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const controller = new AbortController();
    const revision = unitCatalogRevision();
    const ids = Object.values(summaryCallsignsInfo).flatMap(({ res }) =>
      res.flatMap(({ unitId }) => (unitId == null ? [] : [unitId])),
    );
    if (ids.length === 0) return;
    void loadUnitsByIds(ids, { signal: controller.signal })
      .then((units) => {
        if (controller.signal.aborted || revision !== unitCatalogRevision()) return;
        setUnitsMap((current) =>
          revision !== unitCatalogRevision()
            ? current
            : {
                ...current,
                ...Object.fromEntries(units.map((unit) => [unit.id, unit])),
              },
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !isAbortError(error)) {
          onErrorRef.current(toErrorMessage(error));
        }
      });
    return () => controller.abort();
  }, [loadUnitsByIds, summaryCallsignsInfo]);

  useEffect(() => {
    const changed = () => setUnitsMap({});
    window.addEventListener(UNIT_CATALOG_CHANGED_EVENT, changed);
    return () => window.removeEventListener(UNIT_CATALOG_CHANGED_EVENT, changed);
  }, []);

  useEffect(() => {
    setNetworkDisplayMap(buildNetworkDisplayMap(networks, unitsMap));
  }, [networks, unitsMap]);

  useEffect(() => {
    networksRef.current = networks;
  }, [networks]);

  useEffect(() => {
    summaryCallsignsInfoRef.current = summaryCallsignsInfo;
  }, [summaryCallsignsInfo]);

  useEffect(() => {
    unitsMapRef.current = unitsMap;
  }, [unitsMap]);

  useEffect(() => {
    shouldLoadNewCallsignsRef.current = shouldLoadNewCallsigns;
  }, [shouldLoadNewCallsigns]);

  useEffect(() => {
    optionsFreqsRef.current = options.freqs.map((option) => option.value);
  }, [options.freqs, optionsFreqsRef]);

  return {
    loadUnitsByIds,
    groupInfos,
    networkDisplayMap,
    networks,
    networksRef,
    options,
    optionsFreqsRef,
    profiles,
    setGroupInfos,
    setNetworkDisplayMap,
    setNetworks,
    setOptions,
    setProfiles,
    setSummaryCallsignsInfo,
    setTagsMap,
    setTagsOrder,
    setUnitsMap,
    shouldLoadNewCallsignsRef,
    summaryCallsignsInfo,
    summaryCallsignsInfoRef,
    tagsMap,
    tagsOrder,
    unitsMap,
    unitsMapRef,
  };
}
