import type { AnalysisCallsignFrequencyMatchesRsp } from '../../../../../Bindings';
import type { AnalysisCountItem, AnalysisFilterOption } from '../types';
import { AnalysisCountBlock } from './AnalysisCountBlock';
import { AnalysisCallsignFrequencySearch } from './AnalysisCallsignFrequencySearch';
import { Box, Stack } from '@mui/material';

type Props = {
  callsignOptions: AnalysisFilterOption[];
  loading: boolean;
  onAddFreq: (freq: string) => void;
  selectedCallsigns: readonly string[];
  selectedFreqs: readonly string[];
  topCallsigns: AnalysisCountItem[];
  onAddCallsign: (callsign: string) => void;
  onSearchFrequencyMatches: (
    callsigns: string[],
    minMatches: number,
  ) => Promise<AnalysisCallsignFrequencyMatchesRsp | null>;
  onToggleCallsign: (callsign: string) => void;
  onToggleFreq: (freq: string) => void;
};

export function AnalysisCallsignsPane({
  callsignOptions,
  loading,
  onAddFreq,
  selectedCallsigns,
  selectedFreqs,
  topCallsigns,
  onAddCallsign,
  onSearchFrequencyMatches,
  onToggleCallsign,
  onToggleFreq,
}: Props) {
  return (
    <Stack spacing={0}>
      <AnalysisCountBlock
        title="Позивні"
        items={topCallsigns}
        loading={loading}
        onItemAdd={onAddCallsign}
        onItemToggle={onToggleCallsign}
        selectedItemKeys={selectedCallsigns}
      />
      <Box sx={{ borderTop: '1px solid', borderColor: 'divider' }}>
        <AnalysisCallsignFrequencySearch
          callsignOptions={callsignOptions}
          onAddFreq={onAddFreq}
          onSearch={onSearchFrequencyMatches}
          onToggleFreq={onToggleFreq}
          selectedFreqs={selectedFreqs}
        />
      </Box>
    </Stack>
  );
}
