import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import { Box, IconButton, ToggleButton, ToggleButtonGroup, Tooltip } from '@mui/material';

type BaseLayerId = 'googleHybrid' | 'openStreetMap';

export function CoordinateMapPreviewControls({
  baseLayerId,
  canFullscreen,
  isFullscreen,
  onBaseLayerChange,
  onToggleFullscreen,
}: {
  baseLayerId: BaseLayerId;
  canFullscreen: boolean;
  isFullscreen: boolean;
  onBaseLayerChange: (baseLayerId: BaseLayerId) => void;
  onToggleFullscreen: () => void;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        width: '100%',
        px: 3,
        py: 1.5,
        backgroundColor: 'background.paper',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={baseLayerId}
          onChange={(_, nextLayerId: BaseLayerId | null) => {
            if (nextLayerId != null) {
              onBaseLayerChange(nextLayerId);
            }
          }}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexWrap: 'wrap',
            gap: 0.5,
            backgroundColor: 'background.paper',
            '& .MuiToggleButtonGroup-grouped': {
              border: 0,
              borderRadius: 1.5,
              minWidth: 30,
              width: 30,
              height: 30,
              padding: 0,
              color: 'text.secondary',
              backgroundColor: 'transparent',
              '&:hover': {
                backgroundColor: 'action.hover',
              },
              '&.Mui-selected': {
                color: 'primary.main',
                backgroundColor: 'action.selected',
              },
              '&.Mui-selected:hover': {
                backgroundColor: 'action.selected',
              },
            },
          }}
        >
          <Tooltip title="Супутник" enterDelay={300}>
            <ToggleButton aria-label="Супутник" value="googleHybrid">
              <LayersOutlinedIcon fontSize="small" />
            </ToggleButton>
          </Tooltip>
          <Tooltip title="OpenStreetMap" enterDelay={300}>
            <ToggleButton aria-label="OpenStreetMap" value="openStreetMap">
              <MapOutlinedIcon fontSize="small" />
            </ToggleButton>
          </Tooltip>
        </ToggleButtonGroup>
        {canFullscreen ? (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              ml: 0.5,
              pl: 0.5,
              borderLeft: 1,
              borderColor: 'divider',
            }}
          >
            <Tooltip
              title={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'}
              enterDelay={300}
            >
              <IconButton
                aria-label={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'}
                size="small"
                onClick={onToggleFullscreen}
                sx={{
                  color: 'text.secondary',
                }}
              >
                {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
              </IconButton>
            </Tooltip>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
