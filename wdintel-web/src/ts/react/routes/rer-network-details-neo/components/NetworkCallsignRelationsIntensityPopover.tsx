import { Box, Popover, Slider, Stack, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';

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
      open={anchorEl !== null}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      slotProps={{
        paper: {
          style: {
            zIndex: isFullscreen ? NETWORK_RELATIONS_FULLSCREEN_Z_INDEX + 1 : undefined,
          },
          sx: {
            borderRadius: 2,
            overflow: 'hidden',
            bgcolor: graphTheme.overlayBg,
            border: `1px solid ${graphTheme.overlayBorder}`,
            boxShadow: graphTheme.overlayShadow,
          },
        },
      }}
    >
      <Box
        data-testid="graph-intensity-popover"
        data-zindex={isFullscreen ? NETWORK_RELATIONS_FULLSCREEN_Z_INDEX + 1 : undefined}
        style={{ zIndex: isFullscreen ? NETWORK_RELATIONS_FULLSCREEN_Z_INDEX + 1 : undefined }}
        sx={{ width: 280, p: 2, color: graphTheme.overlayText, position: 'relative' }}
      >
        <Stack spacing={1.25}>
          <Stack spacing={0.25}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              Інтенсивність
            </Typography>
            <Typography variant="caption" sx={{ color: graphTheme.overlayTextSecondary }}>
              Мінімум перехоплень для видимого ребра або вузла.
            </Typography>
          </Stack>
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
