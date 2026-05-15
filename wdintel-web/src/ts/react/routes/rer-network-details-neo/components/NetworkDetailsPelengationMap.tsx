import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import WhatshotOutlinedIcon from '@mui/icons-material/WhatshotOutlined';
import { Box, Button, IconButton, Skeleton, Stack, Typography } from '@mui/material';
import { alpha, type Theme } from '@mui/material/styles';
import { createPortal } from 'react-dom';
import { useId, useMemo } from 'react';

import type { NetworkPoint } from '../../../../../Bindings';
import { useNetworkDetailsPelengationMap } from './useNetworkDetailsPelengationMap';

type Props = {
  pelengPoints: NetworkPoint[];
  pelengPointsLoaded: boolean;
  pelengPointsLoading: boolean;
};

function PelengationSkeleton() {
  return (
    <Stack spacing={1.5} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
      <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="space-between" sx={{ flexWrap: 'wrap' }}>
        <Skeleton variant="text" width={180} height={32} />
        <Skeleton variant="rounded" width={180} height={38} sx={{ borderRadius: 2 }} />
      </Stack>
      <Skeleton variant="rounded" sx={{ height: { xs: 220, sm: 280, md: 340 }, borderRadius: 3 }} />
    </Stack>
  );
}

function getMapShellSx(isFullscreen: boolean) {
  return (theme: Theme) => ({
    position: isFullscreen ? 'fixed' : 'relative',
    ...(isFullscreen ? { inset: 0, top: 0, right: 0, bottom: 0, left: 0 } : {}),
    width: isFullscreen ? '100vw' : '100%',
    height: isFullscreen ? '100svh' : 'auto',
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

export function NetworkDetailsPelengationMap({
  pelengPoints,
  pelengPointsLoaded,
  pelengPointsLoading,
}: Props) {
  const headingId = useId().replace(/:/g, '-');
  const {
    mapContainerRef,
    satelliteEnabled,
    setSatelliteEnabled,
    heatmapEnabled,
    setHeatmapEnabled,
    isFullscreen,
    toggleFullscreen,
    mapReady,
  } = useNetworkDetailsPelengationMap(pelengPoints);

  const pointCountLabel = useMemo(() => {
    return `точок: ${pelengPoints.length}`;
  }, [pelengPoints.length]);

  const activeLayerLabel = useMemo(() => {
    const baseLabel = satelliteEnabled ? 'Супутник' : 'Карта';
    return heatmapEnabled ? `${baseLabel} • Heatmap` : baseLabel;
  }, [heatmapEnabled, satelliteEnabled]);

  const showSkeleton = pelengPointsLoading || !pelengPointsLoaded || !mapReady;

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

      <Box
        sx={{
          position: 'absolute',
          right: 16,
          bottom: 14,
          zIndex: 1150,
          px: 1.25,
          py: 0.75,
          borderRadius: 2,
          bgcolor: 'rgba(15, 15, 12, 0.48)',
          backdropFilter: 'blur(8px)',
          border: '1px solid',
          borderColor: 'rgba(255, 255, 255, 0.08)',
        }}
      >
        <Typography variant="body2" sx={{ color: 'rgba(255, 255, 255, 0.78)', fontWeight: 600 }}>
          {`${pointCountLabel} • ${activeLayerLabel}`}
        </Typography>
      </Box>

      {showSkeleton ? (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 1500,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            pt: 2,
            bgcolor: 'rgba(10, 10, 8, 0.24)',
            pointerEvents: 'none',
          }}
        >
          <Box
            sx={{
              width: { xs: '88%', sm: '72%', md: '56%' },
              maxWidth: 520,
              minWidth: 240,
              px: 2,
            }}
          >
            <PelengationSkeleton />
          </Box>
        </Box>
      ) : null}
    </Box>
  );

  const fullscreenMapPanel = isFullscreen && typeof document !== 'undefined' ? createPortal(mapPanel, document.body) : null;

  return (
    <>
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}>
        <Stack spacing={1.5} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
          <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="space-between" sx={{ flexWrap: 'wrap', gap: 1 }}>
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 0, flexWrap: 'wrap' }}>
              <Typography id={headingId} component="h2" variant="h6">
                Пеленгація
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.2 }}>
                {pointCountLabel}
              </Typography>
              {showSkeleton ? <Skeleton variant="rounded" width={84} height={18} sx={{ borderRadius: 1 }} /> : null}
            </Stack>

            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
              <Button
                type="button"
                variant={satelliteEnabled ? 'contained' : 'outlined'}
                onClick={() => setSatelliteEnabled((current) => !current)}
                startIcon={<LayersOutlinedIcon />}
                sx={(theme) => ({
                  borderRadius: 2,
                  px: 1.6,
                  py: 0.8,
                  minWidth: 0,
                  textTransform: 'none',
                  fontWeight: 700,
                  bgcolor: satelliteEnabled ? alpha(theme.palette.warning.main, 0.18) : undefined,
                  color: satelliteEnabled ? theme.palette.warning.main : theme.palette.text.secondary,
                  borderColor: satelliteEnabled ? alpha(theme.palette.warning.main, 0.35) : undefined,
                  '&:hover': {
                    bgcolor: satelliteEnabled ? alpha(theme.palette.warning.main, 0.24) : alpha(theme.palette.text.primary, 0.04),
                    borderColor: satelliteEnabled ? alpha(theme.palette.warning.main, 0.5) : undefined,
                  },
                })}
              >
                Супутник
              </Button>

              <Button
                type="button"
                variant={heatmapEnabled ? 'contained' : 'outlined'}
                onClick={() => setHeatmapEnabled((current) => !current)}
                startIcon={<WhatshotOutlinedIcon />}
                sx={(theme) => ({
                  borderRadius: 2,
                  px: 1.6,
                  py: 0.8,
                  minWidth: 0,
                  textTransform: 'none',
                  fontWeight: 700,
                  bgcolor: heatmapEnabled ? alpha(theme.palette.warning.main, 0.18) : undefined,
                  color: heatmapEnabled ? theme.palette.warning.main : theme.palette.text.secondary,
                  borderColor: heatmapEnabled ? alpha(theme.palette.warning.main, 0.35) : undefined,
                  '&:hover': {
                    bgcolor: heatmapEnabled ? alpha(theme.palette.warning.main, 0.24) : alpha(theme.palette.text.primary, 0.04),
                    borderColor: heatmapEnabled ? alpha(theme.palette.warning.main, 0.5) : undefined,
                  },
                })}
              >
                Heatmap
              </Button>
            </Stack>
          </Stack>
          {isFullscreen ? null : mapPanel}
        </Stack>
      </Box>
      {fullscreenMapPanel}
    </>
  );
}
