import { Box, Paper } from '@mui/material';

import { AnalysisFiltersPanel } from './components/AnalysisFiltersPanel';
import type { AnalysisPageViewModel } from './types';

type Props = {
  page: AnalysisPageViewModel;
  leftPanelVisible: boolean;
};

export function AnalysisLeftPanel({ page, leftPanelVisible }: Props) {
  if (!leftPanelVisible) return null;

  return (
    <Paper
      variant="outlined"
      component="aside"
      aria-label="Панель фільтрів"
      sx={{
        minHeight: 0,
        height: { xs: 'auto', lg: '100%' },
        overflow: 'hidden',
        display: 'block',
      }}
    >
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
        }}
      >
        <AnalysisFiltersPanel page={page} />
      </Box>
    </Paper>
  );
}
