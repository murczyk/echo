import { Box, Stack } from '@mui/material';

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
    <Stack spacing={0}>
      <Box sx={{ pb: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
        <AnalysisCountBlock title="Частоти" items={topFreqs} />
      </Box>
      <Box sx={{ py: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
        <AnalysisCountBlock title="Підрозділи" items={topUnits} />
      </Box>
      <Box sx={{ py: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
        <AnalysisCountBlock title="Локації" items={topLocations} />
      </Box>
      <Box sx={{ py: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
        <AnalysisCorrelatedFreqsCard correlatedFreqs={correlatedFreqs} loading={correlatedFreqsLoading} onLoad={onLoadCorrelatedFreqs} />
      </Box>
      <Box sx={{ pt: 2 }}>
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
