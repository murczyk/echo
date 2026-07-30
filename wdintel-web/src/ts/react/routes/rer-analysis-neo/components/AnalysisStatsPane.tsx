import { Box, Button, Paper, Stack } from '@mui/material';
import { useEffect } from 'react';

import type { CorrelatedFreq, FreqDailyActivityCount } from '../../../../../Bindings';
import type { AnalysisCountItem, AnalysisGroupsActivityPeriod } from '../types';
import { AnalysisCountBlock } from './AnalysisCountBlock';
import { AnalysisCorrelatedFreqsCard } from './AnalysisCorrelatedFreqsCard';
import { AnalysisGroupsActivityCard } from './AnalysisGroupsActivityCard';
import { PowerAlert } from '../../../components/PowerAlert';
import { CompactText } from '../../../components/CompactTypography';
import { normalizeUnknownUnitDisplayValue } from '../../shared/analysis-unit-filter';

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
  onAddFreq: (freq: string) => void;
  onAddLocation: (location: string) => void;
  onAddNetwork: (networkId: string) => void;
  onAddUnit: (unit: string) => void;
  onSelectFreq: (freq: string) => void;
  onToggleFreq: (freq: string) => void;
  onToggleLocation: (location: string) => void;
  onToggleNetwork: (networkId: string) => void;
  onToggleUnit: (unit: string) => void;
  selectedFreq: string | null;
  selectedFreqs: readonly string[];
  selectedLocations: readonly string[];
  selectedNetworks: readonly string[];
  selectedUnits: readonly string[];
  topFreqs: AnalysisCountItem[];
  topLocations: AnalysisCountItem[];
  topNetworks: AnalysisCountItem[];
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
  onAddFreq,
  onAddLocation,
  onAddNetwork,
  onAddUnit,
  onSelectFreq,
  onToggleFreq,
  onToggleLocation,
  onToggleNetwork,
  onToggleUnit,
  selectedFreq,
  selectedFreqs,
  selectedLocations,
  selectedNetworks,
  selectedUnits,
  rightSidebarLoading,
  topFreqs,
  topLocations,
  topNetworks,
  topUnits,
}: Props) {
  const suggestedFreqs = topFreqs
    .filter((item) => item.key.trim().length > 0)
    .map((item) => item.key)
    .slice(0, 6);
  const selectedUnitKeys = selectedUnits.map(normalizeUnknownUnitDisplayValue);

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
          onItemAdd={onAddFreq}
          onItemToggle={onToggleFreq}
          selectedItemKeys={selectedFreqs}
        />
      </Box>
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <AnalysisCountBlock
          title="Мережі"
          items={topNetworks}
          loading={rightSidebarLoading}
          onItemAdd={onAddNetwork}
          onItemToggle={onToggleNetwork}
          selectedItemKeys={selectedNetworks}
        />
      </Box>
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <AnalysisCountBlock
          title="Підрозділи"
          items={topUnits}
          loading={rightSidebarLoading}
          onItemAdd={onAddUnit}
          onItemToggle={onToggleUnit}
          selectedItemKeys={selectedUnitKeys}
        />
      </Box>
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <AnalysisCountBlock
          title="Локації"
          items={topLocations}
          loading={rightSidebarLoading}
          onItemAdd={onAddLocation}
          onItemToggle={onToggleLocation}
          selectedItemKeys={selectedLocations}
        />
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
