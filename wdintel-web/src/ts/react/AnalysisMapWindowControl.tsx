import AddIcon from '@mui/icons-material/Add';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import RemoveIcon from '@mui/icons-material/Remove';
import { Box, IconButton, ThemeProvider } from '@mui/material';
import { alpha, type SxProps, type Theme } from '@mui/material/styles';

import { useNeoMuiTheme } from './mui-theme';

type AnalysisMapWindowControlProps = {
  isFullscreen: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onToggleFullscreen: () => void;
  showFullscreen?: boolean;
};

const buttonSx: SxProps<Theme> = {
  width: 36,
  height: 36,
  borderRadius: 0,
  color: 'text.primary',
  '&:hover': {
    backgroundColor: 'action.hover',
    color: 'text.primary',
  },
  '&:focus-visible': {
    outline: '2px solid var(--bs-primary)',
    outlineOffset: '-2px',
  },
};

function AnalysisMapWindowControlInner({
  showFullscreen = true,
  ...props
}: AnalysisMapWindowControlProps) {
  return (
    <Box
      className="analysis-map-window-control"
      sx={(theme) => ({
        display: 'flex',
        backgroundColor: alpha(theme.palette.background.paper, 0.86),
        backdropFilter: 'blur(6px)',
        border: `1px solid ${alpha(theme.palette.text.primary, 0.16)}`,
        borderRadius: '6px',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
        overflow: 'hidden',
        '& .MuiIconButton-root + .MuiIconButton-root': {
          borderLeft: `1px solid ${alpha(theme.palette.text.primary, 0.16)}`,
        },
      })}
    >
      <IconButton
        aria-label="Збільшити мапу"
        title="Збільшити мапу"
        onClick={props.onZoomIn}
        sx={buttonSx}
      >
        <AddIcon sx={{ fontSize: 20 }} />
      </IconButton>
      <IconButton
        aria-label="Зменшити мапу"
        title="Зменшити мапу"
        onClick={props.onZoomOut}
        sx={buttonSx}
      >
        <RemoveIcon sx={{ fontSize: 20 }} />
      </IconButton>
      {showFullscreen ? (
        <IconButton
          aria-label={props.isFullscreen ? 'Згорнути мапу' : 'Розгорнути мапу'}
          title={props.isFullscreen ? 'Згорнути мапу' : 'Розгорнути мапу'}
          onClick={props.onToggleFullscreen}
          sx={buttonSx}
        >
          {props.isFullscreen ? (
            <FullscreenExitIcon sx={{ fontSize: 20 }} />
          ) : (
            <FullscreenIcon sx={{ fontSize: 20 }} />
          )}
        </IconButton>
      ) : null}
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
