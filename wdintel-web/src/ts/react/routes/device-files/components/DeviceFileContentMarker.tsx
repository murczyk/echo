import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import HighlightOffOutlinedIcon from '@mui/icons-material/HighlightOffOutlined';
import { Box, Tooltip } from '@mui/material';

export const FILE_CONTENT_PRESENT_LABEL = 'Контент файлу наявний';
export const FILE_CONTENT_ABSENT_LABEL = 'Контент файлу відсутній';

export function DeviceFileContentMarker({ hasContent }: { hasContent: boolean }) {
  const label = hasContent ? FILE_CONTENT_PRESENT_LABEL : FILE_CONTENT_ABSENT_LABEL;

  return (
    <Tooltip title={label} arrow>
      <Box
        component="span"
        role="img"
        aria-label={label}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          color: hasContent ? 'success.main' : 'text.disabled',
          cursor: 'default',
        }}
      >
        {hasContent ? (
          <CheckCircleOutlineIcon fontSize="small" />
        ) : (
          <HighlightOffOutlinedIcon fontSize="small" />
        )}
      </Box>
    </Tooltip>
  );
}
