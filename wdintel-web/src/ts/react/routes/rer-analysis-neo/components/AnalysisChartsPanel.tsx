import { Stack } from '@mui/material';
import React from 'react';

import type { CorrelatedFreq, FreqDailyActivityCount } from '../../../../../Bindings';
import type { AnalysisCountItem, AnalysisGroupsActivityPeriod } from '../types';
import { AnalysisCountBlock } from './AnalysisCountBlock';
import { AnalysisCorrelatedFreqsCard } from './AnalysisCorrelatedFreqsCard';
import { AnalysisGroupsActivityCard } from './AnalysisGroupsActivityCard';

type Props = {
  correlatedFreqs: CorrelatedFreq[];
  correlatedFreqsLoading: boolean;
  groupsActivity: FreqDailyActivityCount | null;
  groupsActivityLoading: boolean;
  groupsActivityPeriod: AnalysisGroupsActivityPeriod;
  onLoadCorrelatedFreqs: () => void;
  onLoadGroupsActivity: (period?: AnalysisGroupsActivityPeriod) => void;
  topFreqs: AnalysisCountItem[];
  topLocations: AnalysisCountItem[];
  topUnits: AnalysisCountItem[];
};

export function AnalysisChartsPanel({
  correlatedFreqs,
  correlatedFreqsLoading,
  groupsActivity,
  groupsActivityLoading,
  groupsActivityPeriod,
  onLoadCorrelatedFreqs,
  onLoadGroupsActivity,
  topFreqs,
  topLocations,
  topUnits,
}: Props) {
  return (
    <Stack spacing={2}>
      <AnalysisCountBlock title="Частоти" items={topFreqs} />
      <AnalysisCountBlock title="Підрозділи" items={topUnits} />
      <AnalysisCountBlock title="Локації" items={topLocations} />
      <AnalysisCorrelatedFreqsCard correlatedFreqs={correlatedFreqs} loading={correlatedFreqsLoading} onLoad={onLoadCorrelatedFreqs} />
      <AnalysisGroupsActivityCard
        groupsActivity={groupsActivity}
        loading={groupsActivityLoading}
        period={groupsActivityPeriod}
        onLoad={onLoadGroupsActivity}
      />
    </Stack>
  );
}
