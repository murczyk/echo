import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import { Box, ToggleButton, ToggleButtonGroup, Tooltip } from '@mui/material';

type BaseLayerId = 'googleHybrid' | 'openStreetMap';

export function CoordinateMapPreviewControls({
  baseLayerId,
  onBaseLayerChange,
}: {
  baseLayerId: BaseLayerId;
  onBaseLayerChange: (baseLayerId: BaseLayerId) => void;
}) {
  return (
    <Box
      sx={{
        position: 'absolute',
        bottom: 16,
        left: 16,
        zIndex: 1300,
        pointerEvents: 'auto',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'background.paper',
          backdropFilter: 'blur(12px)',
          borderRadius: 2,
          boxShadow: (theme) =>
            theme.palette.mode === 'dark'
              ? '0 4px 20px rgba(0, 0, 0, 0.35)'
              : '0 4px 20px rgba(0, 0, 0, 0.12)',
          p: 0.5,
          color: 'text.primary',
          border: 1,
          borderColor: 'divider',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
              backgroundColor: 'transparent',
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
                  color: 'text.primary',
                  backgroundColor: 'action.hover',
                },
                '&.Mui-selected': {
                  color: 'text.primary',
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
        </Box>
      </Box>
    </Box>
  );
}
