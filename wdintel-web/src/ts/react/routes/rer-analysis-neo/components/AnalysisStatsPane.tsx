import { Box, Button, Paper, Stack } from '@mui/material';
import { useEffect } from 'react';

import type { CorrelatedFreq, FreqDailyActivityCount } from '../../../../../Bindings';
import type { AnalysisCountItem, AnalysisGroupsActivityPeriod } from '../types';
import { AnalysisCountBlock } from './AnalysisCountBlock';
import { AnalysisCorrelatedFreqsCard } from './AnalysisCorrelatedFreqsCard';
import { AnalysisGroupsActivityCard } from './AnalysisGroupsActivityCard';
import { PowerAlert } from '../../../components/PowerAlert';
import { CompactText } from '../../../components/CompactTypography';

type Props = {
  correlatedFreqs: CorrelatedFreq[];
  correlatedFreqsLoading: boolean;
  rightSidebarLoading: boolean;
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

export function AnalysisStatsPane({
  correlatedFreqs,
  correlatedFreqsLoading,
  groupsActivity,
  groupsActivityLoadedFreq,
  groupsActivityLoadedPeriod,
  groupsActivityLoading,
  groupsActivityPeriod,
  onLoadCorrelatedFreqs,
  onLoadGroupsActivity,
  onSelectFreq,
  selectedFreq,
  rightSidebarLoading,
  topFreqs,
  topLocations,
  topUnits,
}: Props) {
  const suggestedFreqs = topFreqs
    .filter((item) => item.key.trim().length > 0)
    .map((item) => item.key)
    .slice(0, 6);

  useEffect(() => {
    if (!selectedFreq) return;
    onLoadCorrelatedFreqs();
  }, [onLoadCorrelatedFreqs, selectedFreq]);

  return (
    <Stack spacing={0}>
      {selectedFreq ? null : (
        <Paper
          variant="outlined"
          component="section"
          sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}
        >
          <Stack spacing={1.5}>
            <PowerAlert severity="info">
              Оберіть частоту, щоб завантажити суміжні частоти та активність по датах.
            </PowerAlert>
            {suggestedFreqs.length > 0 ? (
              <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                {suggestedFreqs.map((freq) => (
                  <Button
                    key={freq}
                    variant="outlined"
                    size="small"
                    onClick={() => onSelectFreq(freq)}
                  >
                    {freq}
                  </Button>
                ))}
              </Stack>
            ) : (
              <CompactText color="text.secondary">
                Підкажіть частоту через фільтр вище, щоб побачити пов’язані дані.
              </CompactText>
            )}
          </Stack>
        </Paper>
      )}
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <AnalysisCorrelatedFreqsCard
          correlatedFreqs={correlatedFreqs}
          loading={correlatedFreqsLoading}
          selectedFreq={selectedFreq}
        />
      </Box>
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <AnalysisCountBlock
          title="Частоти"
          items={topFreqs}
          loading={rightSidebarLoading}
          onItemAction={onSelectFreq}
          itemActionLabel="У фільтр"
        />
      </Box>
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <AnalysisCountBlock title="Підрозділи" items={topUnits} loading={rightSidebarLoading} />
      </Box>
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <AnalysisCountBlock title="Локації" items={topLocations} loading={rightSidebarLoading} />
      </Box>
      <Box>
        <AnalysisGroupsActivityCard
          groupsActivity={groupsActivity}
          groupsActivityLoadedFreq={groupsActivityLoadedFreq}
          groupsActivityLoadedPeriod={groupsActivityLoadedPeriod}
          loading={groupsActivityLoading}
          period={groupsActivityPeriod}
          onLoad={onLoadGroupsActivity}
          selectedFreq={selectedFreq}
        />
      </Box>
    </Stack>
  );
}
