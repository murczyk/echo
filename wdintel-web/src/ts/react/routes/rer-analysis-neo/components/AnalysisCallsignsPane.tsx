import { Box, Stack } from '@mui/material';

import type { AnalysisCountItem } from '../types';
import { AnalysisCallsignGraphCard } from './AnalysisCallsignGraphCard';
import { AnalysisCallsignsCloudCard } from './AnalysisCallsignsCloudCard';
import type { NetJsonGraphAndMeta } from '../../../../../Bindings';

type Props = {
  callsignGraph: NetJsonGraphAndMeta | null;
  callsignGraphLoading: boolean;
  callsignGraphLoadVersion: number;
  callsignGraphNolimit: boolean;
  visible: boolean;
  onLoadCallsignGraph: () => void;
  onToggleNolimit: () => void;
  rightSidebarLoading: boolean;
  topCallsigns: AnalysisCountItem[];
};

export function AnalysisCallsignsPane({
  callsignGraph,
  callsignGraphLoading,
  callsignGraphLoadVersion,
  callsignGraphNolimit,
  visible,
  onLoadCallsignGraph,
  onToggleNolimit,
  rightSidebarLoading,
  topCallsigns,
}: Props) {
  return (
    <Stack spacing={0}>
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <AnalysisCallsignsCloudCard items={topCallsigns} loading={rightSidebarLoading} />
      </Box>
      <Box>
        <AnalysisCallsignGraphCard
          graph={callsignGraph}
          loading={callsignGraphLoading}
          loadVersion={callsignGraphLoadVersion}
          nolimit={callsignGraphNolimit}
          visible={visible}
          onLoad={onLoadCallsignGraph}
          onToggleNolimit={onToggleNolimit}
        />
      </Box>
    </Stack>
  );
}
