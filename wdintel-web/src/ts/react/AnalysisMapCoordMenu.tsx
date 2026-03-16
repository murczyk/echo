import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { Box, IconButton, MenuItem, Select, SelectChangeEvent, ThemeProvider, Typography } from '@mui/material';
import React from 'react';

import { copyTextToClipboard } from '../copy-to-clipboard';
import { CoordFormat, getCoordinateText } from '../maps/coordinate-copy';
import { useNeoMuiTheme } from './mui-theme';

type AnalysisMapCoordMenuProps = {
  lat: number;
  lng: number;
  mgrsCoords?: string | null;
  onClose: () => void;
};

function AnalysisMapCoordMenuInner(props: AnalysisMapCoordMenuProps) {
  const { lat, lng, mgrsCoords, onClose } = props;
  const [format, setFormat] = React.useState<CoordFormat>('mgrs');

  const value = React.useMemo(
    () => getCoordinateText(format, { lat, lng }, mgrsCoords),
    [format, lat, lng, mgrsCoords],
  );

  const handleCopy = React.useCallback(() => {
    void copyTextToClipboard(value);
  }, [value]);

  const handleFormatChange = React.useCallback((event: SelectChangeEvent<CoordFormat>) => {
    const nextFormat = event.target.value as CoordFormat;
    setFormat(nextFormat);
    void copyTextToClipboard(getCoordinateText(nextFormat, { lat, lng }, mgrsCoords));
  }, [lat, lng, mgrsCoords]);

  return (
    <Box
      className="analysis-map-coord-menu"
      sx={{
        '--analysis-map-coord-menu-bg': (theme) => theme.palette.background.paper,
        '--analysis-map-coord-menu-border': (theme) => theme.palette.divider,
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        minWidth: 220,
        px: 1.5,
        pt: 1.5,
        pb: 1.5,
        borderRadius: 2,
        bgcolor: 'background.paper',
        color: 'text.primary',
        border: 1,
        borderColor: 'divider',
        boxShadow: '0 10px 30px rgba(0, 0, 0, 0.24)',
      }}
    >
      <Box sx={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', alignItems: 'center', gap: 1.5 }}>
        <IconButton
          aria-label="Скопіювати координати"
          title="Скопіювати координати"
          onClick={handleCopy}
          size="small"
          sx={{
            width: 40,
            height: 40,
            borderRadius: 1.25,
            border: 1,
            borderColor: 'divider',
          }}
        >
          <ContentCopyIcon fontSize="small" />
        </IconButton>

        <Select<CoordFormat>
          value={format}
          onChange={handleFormatChange}
          size="small"
          variant="outlined"
          aria-label="Формат координат"
          MenuProps={{
            slotProps: {
              root: {
                sx: {
                  zIndex: 11001,
                },
              },
              backdrop: {
                sx: {
                  zIndex: 11000,
                },
              },
              paper: {
                sx: {
                  zIndex: 11001,
                },
              },
            },
          }}
          sx={{
            minHeight: 40,
            fontSize: 14,
            fontWeight: 600,
            '& .MuiSelect-select': {
              display: 'flex',
              alignItems: 'center',
              minHeight: '40px !important',
              py: 0,
            },
          }}
        >
          <MenuItem value="mgrs">MGRS</MenuItem>
          <MenuItem value="wgs">WGS</MenuItem>
        </Select>

        <IconButton
          aria-label="Закрити меню координат"
          onClick={onClose}
          size="small"
          sx={{
            width: 34,
            height: 34,
            borderRadius: 1,
            color: 'text.primary',
            '&:hover': {
              bgcolor: 'action.hover',
            },
            '&.Mui-focusVisible': {
              outline: 'none',
              boxShadow: 'none',
            },
          }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      <Typography
        sx={{
          fontSize: 16,
          fontWeight: 500,
          lineHeight: 1.2,
          letterSpacing: '0.04em',
          textAlign: 'center',
          wordBreak: 'break-word',
          px: 0.5,
          py: 0.25,
        }}
      >
        {value}
      </Typography>
    </Box>
  );
}

export function AnalysisMapCoordMenu(props: AnalysisMapCoordMenuProps) {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <AnalysisMapCoordMenuInner {...props} />
    </ThemeProvider>
  );
}
