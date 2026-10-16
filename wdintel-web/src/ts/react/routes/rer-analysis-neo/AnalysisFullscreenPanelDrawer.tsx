import { Box, Drawer } from '@mui/material';
import type { ReactNode } from 'react';

import { AnalysisPanelHeader } from './AnalysisPanelHeader';

type Props = {
  anchor: 'left' | 'right';
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  maxPanelWidth?: number;
  subtitle?: string;
  closeLabel?: string;
};

export function AnalysisFullscreenPanelDrawer({
  anchor,
  title,
  open,
  onClose,
  children,
  maxPanelWidth,
  subtitle,
  closeLabel,
}: Props) {
  const resolvedCloseLabel =
    closeLabel ?? (anchor === 'left' ? 'Закрити ліву панель' : 'Закрити праву панель');

  return (
    <Drawer
      anchor={anchor}
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: (theme) => ({
            width: maxPanelWidth ? { xs: '100vw', sm: maxPanelWidth } : '100vw',
            maxWidth: '100vw',
            height: '100dvh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            bgcolor: 'background.default',
            '--analysis-panel-background': theme.palette.background.default,
            backgroundImage: 'none',
          }),
        },
      }}
    >
      <AnalysisPanelHeader
        title={title}
        subtitle={subtitle}
        closeLabel={resolvedCloseLabel}
        onClose={onClose}
      />
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>{children}</Box>
    </Drawer>
  );
}
