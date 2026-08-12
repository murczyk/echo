import { Box } from '@mui/material';

import { AnalysisSidebar } from './components/AnalysisSidebar';
import type { AnalysisPageViewModel } from './types';

type Props = {
  page: AnalysisPageViewModel;
  rightPanelVisible: boolean;
  isCompactLayout?: boolean;
  showNarrowCloseButton?: boolean;
};

// Flat, divider-only: no outlined card. The center panel already owns the
// center→right hairline, so this column stays borderless to avoid doubling
// the line. Inner panes are flattened by AnalysisSidebar's scroll box, which
// strips descendant Paper borders and separates children with a single divider.
export function AnalysisRightPanel({
  page,
  rightPanelVisible,
  isCompactLayout = false,
  showNarrowCloseButton = true,
}: Props) {
  if (!rightPanelVisible) return null;

  return (
    <Box
      sx={{
        minHeight: 0,
        height: '100%',
        overflow: 'hidden',
        display: 'flex',
      }}
      data-analysis-right-panel
    >
      <Box
        sx={{
          flex: 1,
          height: '100%',
          minHeight: 0,
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        <AnalysisSidebar
          {...page}
          isCompactLayout={isCompactLayout}
          showNarrowCloseButton={showNarrowCloseButton}
        />
      </Box>
    </Box>
  );
}
