import { useEffect, useRef, useState } from 'react';

import type {
  CallsignInfoRes,
  Network,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
  Unit,
  User,
} from '../../../../Bindings';
import { buildNetworkDisplayMap } from './message-utils';
import type { AnalysisFilterOptions } from './types';
import { emptyOptions } from './use-analysis-data.shared';

type Params = {
  currentUser: User | null;
  shouldLoadNewCallsigns: boolean;
};

export function useAnalysisReferenceState({ currentUser, shouldLoadNewCallsigns }: Params) {
  const [options, setOptions] = useState<AnalysisFilterOptions>(emptyOptions);
  const [profiles, setProfiles] = useState<Record<string, SignalProfileEntry | null>>({});
  const [groupInfos, setGroupInfos] = useState<Record<string, SignalGroupEntry>>({});
  const [users, setUsers] = useState<Record<string, User | null>>({});
  const [tagsMap, setTagsMap] = useState<Record<number, Tag>>({});
  const [networkDisplayMap, setNetworkDisplayMap] = useState<Record<number, string>>({});
  const [networks, setNetworks] = useState<Network[]>([]);
  const [summaryCallsignsInfo, setSummaryCallsignsInfo] = useState<Record<string, CallsignInfoRes>>({});
  const [unitsMap, setUnitsMap] = useState<Record<number, Unit>>({});
  const networksRef = useRef(networks);
  const currentUserRef = useRef(currentUser);
  const usersRef = useRef(users);
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
    currentUserRef.current = currentUser;
  }, [currentUser]);

  useEffect(() => {
    usersRef.current = users;
  }, [users]);

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
    currentUserRef,
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
    setUnitsMap,
    setUsers,
    shouldLoadNewCallsignsRef,
    summaryCallsignsInfo,
    summaryCallsignsInfoRef,
    tagsMap,
    unitsMap,
    unitsMapRef,
    users,
    usersRef,
  };
}
