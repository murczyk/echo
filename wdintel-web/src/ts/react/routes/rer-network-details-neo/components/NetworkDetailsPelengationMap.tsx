import { Box, IconButton } from '@mui/material';
import { alpha, type Theme } from '@mui/material/styles';
import { createPortal } from 'react-dom';

import type { NetworkPoint } from '../../../../../Bindings';
import { useNetworkDetailsPelengationMap } from './useNetworkDetailsPelengationMap';

type Props = {
  pelengPoints: NetworkPoint[];
  showLabels: boolean;
  satelliteEnabled: boolean;
  heatmapEnabled: boolean;
};

function getMapShellSx(isFullscreen: boolean) {
  return (theme: Theme) => ({
    position: isFullscreen ? 'fixed' : 'relative',
    ...(isFullscreen ? { inset: 0, top: 0, right: 0, bottom: 0, left: 0 } : {}),
    width: '100%',
    height: isFullscreen ? '100svh' : '100%',
    ...(isFullscreen ? { maxWidth: '100vw', maxHeight: '100svh', m: 0, p: 0 } : {}),
    zIndex: isFullscreen ? 10000 : 'auto',
    minHeight: { xs: 320, sm: 360, md: 420 },
    flex: 1,
    overflow: 'hidden',
    borderRadius: isFullscreen ? 0 : 3,
    border: isFullscreen ? 'none' : '1px solid',
    borderColor: alpha(theme.palette.divider, 0.8),
    bgcolor: '#151510',
    backgroundImage: `
      radial-gradient(circle at 20% 18%, rgba(136, 162, 99, 0.22), transparent 28%),
      radial-gradient(circle at 72% 28%, rgba(181, 126, 68, 0.22), transparent 26%),
      radial-gradient(circle at 42% 72%, rgba(87, 132, 86, 0.18), transparent 30%),
      linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(0, 0, 0, 0.22)),
      linear-gradient(135deg, rgba(63, 83, 48, 0.25), rgba(29, 26, 20, 0.15))
    `,
    boxShadow: isFullscreen ? 'none' : 'inset 0 0 0 1px rgba(255, 255, 255, 0.03)',
  });
}

function getMapControlSx(theme: Theme) {
  const analysisMapControl =
    theme.palette.mode === 'dark'
      ? {
          bg: '#212529',
          border: '#495057',
          color: '#dee2e6',
          hoverBg: '#343a40',
        }
      : {
          bg: '#ffffff',
          border: '#dee2e6',
          color: '#212529',
          hoverBg: '#f8f9fa',
        };

  return {
    position: 'absolute',
    top: 10,
    right: 10,
    zIndex: 1200,
    width: 44,
    height: 44,
    p: 0,
    borderRadius: '8px',
    bgcolor: analysisMapControl.bg,
    color: analysisMapControl.color,
    border: '1px solid',
    borderColor: analysisMapControl.border,
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
    transition: 'background-color 0.2s, color 0.2s',
    '&:hover': {
      bgcolor: analysisMapControl.hoverBg,
      color: analysisMapControl.color,
    },
    '&.Mui-focusVisible': {
      outline: 'none',
      boxShadow: `0 0 0 3px ${alpha(theme.palette.primary.main, 0.4)}`,
    },
    '& i': {
      fontSize: 18,
      lineHeight: 1,
    },
  };
}

export function NetworkDetailsPelengationMap({ pelengPoints, showLabels, satelliteEnabled, heatmapEnabled }: Props) {
  const { mapContainerRef, isFullscreen, toggleFullscreen } = useNetworkDetailsPelengationMap(pelengPoints, showLabels, satelliteEnabled, heatmapEnabled);

  const mapPanel = (
    <Box component="section" sx={getMapShellSx(isFullscreen)}>
      <Box
        ref={mapContainerRef}
        sx={{
          position: 'absolute',
          inset: 0,
          zIndex: 100,
          '& .leaflet-container': {
            background: 'transparent',
          },
          '& .leaflet-popup-content-wrapper': {
            borderRadius: 2,
            bgcolor: 'rgba(18, 20, 18, 0.95)',
            color: 'common.white',
          },
          '& .leaflet-popup-tip': {
            bgcolor: 'rgba(18, 20, 18, 0.95)',
          },
          '& .leaflet-popup-content': {
            margin: 1.25,
            color: 'common.white',
          },
        }}
      />

      <IconButton
        aria-label={isFullscreen ? 'Згорнути мапу' : 'Розгорнути мапу'}
        title={isFullscreen ? 'Згорнути мапу' : 'Розгорнути мапу'}
        onClick={toggleFullscreen}
        sx={getMapControlSx}
      >
        <Box component="i" className={isFullscreen ? 'bi bi-fullscreen-exit' : 'bi bi-arrows-fullscreen'} aria-hidden="true" />
      </IconButton>
    </Box>
  );

  const fullscreenMapPanel = isFullscreen && typeof document !== 'undefined' ? createPortal(mapPanel, document.body) : null;

  return (
    <>
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', flex: 1, display: 'flex' }}>
          {isFullscreen ? null : mapPanel}
        </Box>
      </Box>
      {fullscreenMapPanel}
    </>
  );
}
