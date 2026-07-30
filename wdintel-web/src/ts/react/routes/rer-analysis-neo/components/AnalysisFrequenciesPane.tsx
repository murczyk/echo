import { Stack } from '@mui/material';

import type { CorrelatedFreq, FreqDailyActivityCount } from '../../../../../Bindings';
import type { AnalysisCountItem, AnalysisGroupsActivityPeriod } from '../types';
import { AnalysisCountBlock } from './AnalysisCountBlock';
import { AnalysisCorrelatedFreqsCard } from './AnalysisCorrelatedFreqsCard';
import { AnalysisGroupsActivityCard } from './AnalysisGroupsActivityCard';

type Props = {
  correlatedFreqs: CorrelatedFreq[];
  correlatedFreqsLoaded: boolean;
  correlatedFreqsLoading: boolean;
  groupsActivity: FreqDailyActivityCount | null;
  groupsActivityLoadedFreq: string | null;
  groupsActivityLoadedPeriod: AnalysisGroupsActivityPeriod | null;
  groupsActivityLoading: boolean;
  groupsActivityPeriod: AnalysisGroupsActivityPeriod;
  onAddFreq: (freq: string) => void;
  onLoadCorrelatedFreqs: () => void;
  onLoadGroupsActivity: (period?: AnalysisGroupsActivityPeriod) => void;
  onToggleFreq: (freq: string) => void;
  selectedFreq: string | null;
  selectedFreqs: readonly string[];
  topFreqs: AnalysisCountItem[];
};

export function AnalysisFrequenciesPane({
  correlatedFreqs,
  correlatedFreqsLoaded,
  correlatedFreqsLoading,
  groupsActivity,
  groupsActivityLoadedFreq,
  groupsActivityLoadedPeriod,
  groupsActivityLoading,
  groupsActivityPeriod,
  onAddFreq,
  onLoadCorrelatedFreqs,
  onLoadGroupsActivity,
  onToggleFreq,
  selectedFreq,
  selectedFreqs,
  topFreqs,
}: Props) {
  return (
    <Stack spacing={0}>
      <AnalysisCountBlock
        title="Частоти"
        items={topFreqs}
        onItemAdd={onAddFreq}
        onItemToggle={onToggleFreq}
        selectedItemKeys={selectedFreqs}
      />
      <AnalysisCorrelatedFreqsCard
        correlatedFreqs={correlatedFreqs}
        loaded={correlatedFreqsLoaded}
        loading={correlatedFreqsLoading}
        onLoad={onLoadCorrelatedFreqs}
        selectedFreq={selectedFreq}
      />
      <AnalysisGroupsActivityCard
        groupsActivity={groupsActivity}
        groupsActivityLoadedFreq={groupsActivityLoadedFreq}
        groupsActivityLoadedPeriod={groupsActivityLoadedPeriod}
        loading={groupsActivityLoading}
        period={groupsActivityPeriod}
        onLoad={onLoadGroupsActivity}
        selectedFreq={selectedFreq}
      />
    </Stack>
  );
}
