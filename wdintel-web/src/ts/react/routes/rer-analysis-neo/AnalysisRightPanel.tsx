import { Box, Paper } from '@mui/material';

import { AnalysisSidebar } from './components/AnalysisSidebar';
import type { AnalysisPageViewModel } from './types';

type Props = {
  page: AnalysisPageViewModel;
  rightPanelVisible: boolean;
};

export function AnalysisRightPanel({ page, rightPanelVisible }: Props) {
  if (!rightPanelVisible) return null;

  return (
    <Paper
      variant="outlined"
      component="aside"
      aria-label="Аналітична права секція"
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
    </Paper>
  );
}
