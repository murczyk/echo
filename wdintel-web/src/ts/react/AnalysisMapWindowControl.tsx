import AddIcon from '@mui/icons-material/Add';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import RemoveIcon from '@mui/icons-material/Remove';
import { Box, IconButton, ThemeProvider } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';

import { useNeoMuiTheme } from './mui-theme';

type AnalysisMapWindowControlProps = {
  isFullscreen: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onToggleFullscreen: () => void;
};

const buttonSx: SxProps<Theme> = {
  width: 44,
  height: 44,
  borderRadius: 0,
  color: 'var(--bs-body-color)',
  '&:hover': {
    backgroundColor: 'var(--bs-secondary-bg)',
    color: 'var(--bs-primary)',
  },
  '&:focus-visible': {
    outline: '2px solid var(--bs-primary)',
    outlineOffset: '-2px',
  },
};

function AnalysisMapWindowControlInner(props: AnalysisMapWindowControlProps) {
  return (
    <Box
      className="analysis-map-window-control"
      sx={{
        display: 'flex',
        background: 'var(--bs-card-bg)',
        border: '1px solid var(--bs-border-color)',
        borderRadius: '8px',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
        overflow: 'hidden',
        '& .MuiIconButton-root + .MuiIconButton-root': {
          borderLeft: '1px solid var(--bs-border-color)',
        },
      }}
    >
      <IconButton
        aria-label="Збільшити мапу"
        title="Збільшити мапу"
        onClick={props.onZoomIn}
        sx={buttonSx}
      >
        <AddIcon sx={{ fontSize: 24 }} />
      </IconButton>
      <IconButton
        aria-label="Зменшити мапу"
        title="Зменшити мапу"
        onClick={props.onZoomOut}
        sx={buttonSx}
      >
        <RemoveIcon sx={{ fontSize: 24 }} />
      </IconButton>
      <IconButton
        aria-label={props.isFullscreen ? 'Згорнути мапу' : 'Розгорнути мапу'}
        title={props.isFullscreen ? 'Згорнути мапу' : 'Розгорнути мапу'}
        onClick={props.onToggleFullscreen}
        sx={buttonSx}
      >
        {props.isFullscreen ? (
          <FullscreenExitIcon sx={{ fontSize: 24 }} />
        ) : (
          <FullscreenIcon sx={{ fontSize: 24 }} />
        )}
      </IconButton>
    </Box>
  );
}

export function AnalysisMapWindowControl(props: AnalysisMapWindowControlProps) {
  const theme = useNeoMuiTheme();
  return (
    <ThemeProvider theme={theme}>
      <AnalysisMapWindowControlInner {...props} />
    </ThemeProvider>
  );
}
