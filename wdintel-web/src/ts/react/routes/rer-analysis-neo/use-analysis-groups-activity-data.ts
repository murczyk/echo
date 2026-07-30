import { useCallback, useState } from 'react';

import type { FreqDailyActivityCount } from '../../../../Bindings';
import { fetchAnalysisActivityDaily, fetchFreqActivityDaily } from '../../services/api/analysis';
import { isNullOrUndefined } from '../../utils/misc';
import { buildAnalysisReq } from './helpers';
import { toErrorMessage } from './use-analysis-data.shared';
import type { AnalysisGroupsActivityPeriod, AnalysisQueryState } from './types';

type Params = {
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqValues: string[];
  queryState: AnalysisQueryState;
};

export function useAnalysisGroupsActivityData({
  onError,
  onUnauthorized,
  optionsFreqValues,
  queryState,
}: Params) {
  const [groupsActivity, setGroupsActivity] = useState<FreqDailyActivityCount | null>(null);
  const [groupsActivityLoadedFreq, setGroupsActivityLoadedFreq] = useState<string | null>(null);
  const [groupsActivityLoadedPeriod, setGroupsActivityLoadedPeriod] =
    useState<AnalysisGroupsActivityPeriod | null>(null);
  const [groupsActivityLoading, setGroupsActivityLoading] = useState(false);
  const [groupsActivityPeriod, setGroupsActivityPeriod] =
    useState<AnalysisGroupsActivityPeriod>('selected');

  const loadGroupsActivity = useCallback(
    async (period?: AnalysisGroupsActivityPeriod) => {
      const analysisReq = buildAnalysisReq(queryState, optionsFreqValues);
      const firstFreq = queryState.freqsSelected[0];
      if (isNullOrUndefined(analysisReq)) {
        setGroupsActivity(null);
        setGroupsActivityLoadedFreq(null);
        setGroupsActivityLoadedPeriod(null);
        return;
      }

      const nextPeriod = period ?? groupsActivityPeriod;
      const tillDateInclusiveMs = analysisReq.tillDateNoninclusiveMs;
      const dayMs = 24 * 60 * 60 * 1000;
      const sinceDateInclusiveMs =
        nextPeriod === 'month'
          ? tillDateInclusiveMs - 30 * dayMs
          : nextPeriod === 'quarter'
            ? tillDateInclusiveMs - 90 * dayMs
            : nextPeriod === 'year'
              ? tillDateInclusiveMs - 365 * dayMs
              : analysisReq.sinceDateInclusiveMs;

      setGroupsActivityLoading(true);
      setGroupsActivityPeriod(nextPeriod);
      try {
        const rsp = firstFreq
          ? await fetchFreqActivityDaily({
              freq: firstFreq,
              sinceDateInclusiveMs,
              tillDateInclusiveMs,
            })
          : await fetchAnalysisActivityDaily({
              ...analysisReq,
              sinceDateInclusiveMs,
              tillDateNoninclusiveMs: tillDateInclusiveMs,
            });
        setGroupsActivity(rsp);
        setGroupsActivityLoadedFreq(firstFreq ?? null);
        setGroupsActivityLoadedPeriod(nextPeriod);
      } catch (loadError) {
        if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
      } finally {
        setGroupsActivityLoading(false);
      }
    },
    [groupsActivityPeriod, onError, onUnauthorized, optionsFreqValues, queryState],
  );

  return {
    groupsActivity,
    groupsActivityLoadedFreq,
    groupsActivityLoadedPeriod,
    groupsActivityLoading,
    groupsActivityPeriod,
    loadGroupsActivity,
    setGroupsActivity,
    setGroupsActivityLoadedFreq,
    setGroupsActivityLoadedPeriod,
    setGroupsActivityLoading,
    setGroupsActivityPeriod,
  };
}
