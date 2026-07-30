import { Box, Stack } from '@mui/material';

import type { AnalysisCountItem } from '../types';
import { AnalysisCountBlock } from './AnalysisCountBlock';
import { normalizeUnknownUnitDisplayValue } from '../../shared/analysis-unit-filter';

type Props = {
  groupsLoading: boolean;
  rightSidebarLoading: boolean;
  onAddFreq: (freq: string) => void;
  onAddGroup: (groupKey: string) => void;
  onAddLocation: (location: string) => void;
  onAddNetwork: (networkId: string) => void;
  onAddUnit: (unit: string) => void;
  onToggleFreq: (freq: string) => void;
  onToggleGroup: (groupKey: string) => void;
  onToggleLocation: (location: string) => void;
  onToggleNetwork: (networkId: string) => void;
  onToggleUnit: (unit: string) => void;
  selectedFreqs: readonly string[];
  selectedGroups: readonly string[];
  selectedLocations: readonly string[];
  selectedNetworks: readonly string[];
  selectedUnits: readonly string[];
  topFreqs: AnalysisCountItem[];
  topGroups: AnalysisCountItem[];
  topLocations: AnalysisCountItem[];
  topNetworks: AnalysisCountItem[];
  topUnits: AnalysisCountItem[];
};

export function AnalysisStatsPane({
  groupsLoading,
  onAddFreq,
  onAddGroup,
  onAddLocation,
  onAddNetwork,
  onAddUnit,
  onToggleFreq,
  onToggleGroup,
  onToggleLocation,
  onToggleNetwork,
  onToggleUnit,
  selectedFreqs,
  selectedGroups,
  selectedLocations,
  selectedNetworks,
  selectedUnits,
  rightSidebarLoading,
  topFreqs,
  topGroups,
  topLocations,
  topNetworks,
  topUnits,
}: Props) {
  const selectedUnitKeys = selectedUnits.map(normalizeUnknownUnitDisplayValue);

  return (
    <Stack spacing={0}>
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <AnalysisCountBlock
          title="Групи"
          items={topGroups}
          loading={groupsLoading}
          onItemAdd={onAddGroup}
          onItemToggle={onToggleGroup}
          selectedItemKeys={selectedGroups}
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
    </Stack>
  );
}
