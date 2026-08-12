import { Box, Popover, Slider, Stack, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';

import { NETWORK_RELATIONS_FULLSCREEN_Z_INDEX } from './network-relations-graph-theme';
import { getNetworkRelationsGraphTheme } from './network-relations-graph-theme';

type Props = {
  anchorEl: HTMLElement | null;
  popoverId: string;
  minIntensity: number;
  intensitySliderMax: number;
  isFullscreen: boolean;
  onClose: () => void;
  onMinIntensityChange: (value: number) => void;
};

export function NetworkCallsignRelationsIntensityPopover({
  anchorEl,
  popoverId,
  minIntensity,
  intensitySliderMax,
  isFullscreen,
  onClose,
  onMinIntensityChange,
}: Props) {
  const theme = useTheme();
  const graphTheme = getNetworkRelationsGraphTheme(theme);

  return (
    <Popover
      id={popoverId}
      data-testid="graph-intensity-popover-root"
      open={anchorEl !== null}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      sx={{ zIndex: isFullscreen ? NETWORK_RELATIONS_FULLSCREEN_Z_INDEX + 1 : undefined }}
      slotProps={{
        paper: {
          style: {
            zIndex: isFullscreen ? NETWORK_RELATIONS_FULLSCREEN_Z_INDEX + 1 : undefined,
          },
          sx: {
            borderRadius: 1,
            overflow: 'hidden',
            bgcolor: alpha(
              theme.palette.background.paper,
              theme.palette.mode === 'dark' ? 0.86 : 0.92,
            ),
            backgroundImage: 'none',
            backdropFilter: 'blur(6px)',
            border: `1px solid ${alpha(
              theme.palette.text.primary,
              theme.palette.mode === 'dark' ? 0.14 : 0.12,
            )}`,
            boxShadow:
              theme.palette.mode === 'dark'
                ? '0 4px 12px rgba(0,0,0,0.18)'
                : '0 4px 12px rgba(0,0,0,0.06)',
          },
        },
      }}
    >
      <Box
        data-testid="graph-intensity-popover"
        data-zindex={isFullscreen ? NETWORK_RELATIONS_FULLSCREEN_Z_INDEX + 1 : undefined}
        style={{ zIndex: isFullscreen ? NETWORK_RELATIONS_FULLSCREEN_Z_INDEX + 1 : undefined }}
        sx={{ width: 250, p: 1.25, color: graphTheme.overlayText, position: 'relative' }}
      >
        <Stack spacing={1}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            Інтенсивність
          </Typography>
          <Stack spacing={0.5}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                Поріг
              </Typography>
              <Typography variant="caption" sx={{ color: graphTheme.overlayTextSecondary }}>
                {minIntensity}
              </Typography>
            </Stack>
            <Slider
              value={minIntensity}
              min={1}
              max={intensitySliderMax}
              step={1}
              track="normal"
              onChange={(_, value) =>
                onMinIntensityChange(Array.isArray(value) ? (value[0] ?? minIntensity) : value)
              }
              sx={{
                '& .MuiSlider-track': {
                  border: 'none',
                },
                '& .MuiSlider-rail': {
                  opacity: 0.38,
                },
                '& .MuiSlider-mark': {
                  display: 'none',
                },
              }}
            />
          </Stack>
        </Stack>
      </Box>
    </Popover>
  );
}
