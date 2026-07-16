import { Box } from '@mui/material';

import { AnalysisSidebar } from './components/AnalysisSidebar';
import type { AnalysisPageViewModel } from './types';

type Props = {
  page: AnalysisPageViewModel;
  rightPanelVisible: boolean;
};

// Flat, divider-only: no outlined card. The center panel already owns the
// center→right hairline, so this column stays borderless to avoid doubling
// the line. Inner panes are flattened by AnalysisSidebar's scroll box, which
// strips descendant Paper borders and separates children with a single divider.
export function AnalysisRightPanel({ page, rightPanelVisible }: Props) {
  if (!rightPanelVisible) return null;

  return (
    <Box
      sx={{
        minHeight: 0,
        height: { xs: 'auto', lg: '100%' },
        overflow: 'hidden',
        display: 'flex',
      }}
    >
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        <AnalysisSidebar {...page} />
      </Box>
    </Box>
  );
}
