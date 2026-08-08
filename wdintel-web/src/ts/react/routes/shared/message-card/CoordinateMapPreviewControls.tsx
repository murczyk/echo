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
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(18, 18, 18, 0.75)',
        backdropFilter: 'blur(12px)',
        borderRadius: 3,
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.25)',
        px: 2,
        py: 1,
        color: '#fff',
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
              color: 'rgba(255, 255, 255, 0.85)',
              backgroundColor: 'transparent',
              '&:hover': {
                backgroundColor: 'rgba(255, 255, 255, 0.1)',
              },
              '&.Mui-selected': {
                color: '#fff',
                backgroundColor: 'rgba(255, 255, 255, 0.2)',
              },
              '&.Mui-selected:hover': {
                backgroundColor: 'rgba(255, 255, 255, 0.25)',
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
  );
}
