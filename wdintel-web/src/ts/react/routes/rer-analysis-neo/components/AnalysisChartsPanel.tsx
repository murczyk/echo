import { Box, Stack } from '@mui/material';

import type { CorrelatedFreq, FreqDailyActivityCount } from '../../../../../Bindings';
import type { AnalysisCountItem, AnalysisGroupsActivityPeriod } from '../types';
import { AnalysisCountBlock } from './AnalysisCountBlock';
import { AnalysisCorrelatedFreqsCard } from './AnalysisCorrelatedFreqsCard';
import { AnalysisGroupsActivityCard } from './AnalysisGroupsActivityCard';

type Props = {
  correlatedFreqs: CorrelatedFreq[];
  correlatedFreqsLoading: boolean;
  filtersLoading: boolean;
  groupsActivity: FreqDailyActivityCount | null;
  groupsActivityLoadedFreq: string | null;
  groupsActivityLoadedPeriod: AnalysisGroupsActivityPeriod | null;
  groupsActivityLoading: boolean;
  groupsActivityPeriod: AnalysisGroupsActivityPeriod;
  onLoadCorrelatedFreqs: () => void;
  onLoadGroupsActivity: (period?: AnalysisGroupsActivityPeriod) => void;
  onSelectFreq: (freq: string) => void;
  selectedFreq: string | null;
  topFreqs: AnalysisCountItem[];
  topLocations: AnalysisCountItem[];
  topUnits: AnalysisCountItem[];
};

export function AnalysisChartsPanel({
  correlatedFreqs,
  correlatedFreqsLoading,
  filtersLoading,
  groupsActivity,
  groupsActivityLoadedFreq,
  groupsActivityLoadedPeriod,
  groupsActivityLoading,
  groupsActivityPeriod,
  onLoadCorrelatedFreqs,
  onLoadGroupsActivity,
  onSelectFreq,
  selectedFreq,
  topFreqs,
  topLocations,
  topUnits,
}: Props) {
  const suggestedFreqs = topFreqs
    .filter((item) => item.key.trim().length > 0)
    .map((item) => item.key)
    .slice(0, 6);

  return (
    <Stack spacing={0}>
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <AnalysisCountBlock title="Частоти" items={topFreqs} loading={filtersLoading} onItemAction={onSelectFreq} itemActionLabel="У фільтр" />
      </Box>
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <AnalysisCountBlock title="Підрозділи" items={topUnits} loading={filtersLoading} />
      </Box>
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <AnalysisCountBlock title="Локації" items={topLocations} loading={filtersLoading} />
      </Box>
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <AnalysisCorrelatedFreqsCard correlatedFreqs={correlatedFreqs} loading={correlatedFreqsLoading} onLoad={onLoadCorrelatedFreqs} />
      </Box>
      <Box>
        <AnalysisGroupsActivityCard
          groupsActivity={groupsActivity}
          groupsActivityLoadedFreq={groupsActivityLoadedFreq}
          groupsActivityLoadedPeriod={groupsActivityLoadedPeriod}
          loading={groupsActivityLoading}
          period={groupsActivityPeriod}
          onLoad={onLoadGroupsActivity}
          onSelectFreq={onSelectFreq}
          selectedFreq={selectedFreq}
          suggestedFreqs={suggestedFreqs}
        />
      </Box>
    </Stack>
  );
}
