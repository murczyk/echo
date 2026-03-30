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
  groupsActivityLoading: boolean;
  groupsActivityPeriod: AnalysisGroupsActivityPeriod;
  onLoadCorrelatedFreqs: () => void;
  onLoadGroupsActivity: (period?: AnalysisGroupsActivityPeriod) => void;
  onSelectFreq: (freq: string) => void;
  topFreqs: AnalysisCountItem[];
  topLocations: AnalysisCountItem[];
  topUnits: AnalysisCountItem[];
};

export function AnalysisChartsPanel({
  correlatedFreqs,
  correlatedFreqsLoading,
  filtersLoading,
  groupsActivity,
  groupsActivityLoading,
  groupsActivityPeriod,
  onLoadCorrelatedFreqs,
  onLoadGroupsActivity,
  onSelectFreq,
  topFreqs,
  topLocations,
  topUnits,
}: Props) {
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
          loading={groupsActivityLoading}
          period={groupsActivityPeriod}
          onLoad={onLoadGroupsActivity}
        />
      </Box>
    </Stack>
  );
}
