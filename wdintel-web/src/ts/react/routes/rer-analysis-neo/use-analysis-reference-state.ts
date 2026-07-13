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

type Params = {
  shouldLoadNewCallsigns: boolean;
};

export function useAnalysisReferenceState({ shouldLoadNewCallsigns }: Params) {
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
