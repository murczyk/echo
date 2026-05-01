import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SettingsIcon from '@mui/icons-material/Settings';
import { Box, Checkbox, IconButton, ThemeProvider, Typography } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';

import { useNeoMuiTheme } from './mui-theme';

type AnalysisMapSettingsControlProps = {
  visible: boolean;
  forceCollapsed?: boolean;
  onVisibleChange: (visible: boolean) => void;
};

function AnalysisMapSettingsControlInner(props: AnalysisMapSettingsControlProps) {
  const [isCollapsed, setCollapsed] = useState(true);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev);
  }, []);

  const toggleVisible = useCallback(() => {
    props.onVisibleChange(!props.visible);
  }, [props]);

  useEffect(() => {
    if (!props.forceCollapsed) {
      return;
    }
    setCollapsed(true);
  }, [props.forceCollapsed]);

  return (
    <Box className={`palitras-control map-settings-control ${isCollapsed ? 'collapsed' : ''}`}>
      <Box className="palitras-control-header">
        {isCollapsed ? (
          <IconButton
            className="palitras-palette-icon map-settings-toggle-icon"
            onClick={toggleCollapsed}
            aria-label="Налаштування мапи"
            title="Налаштування мапи"
            size="small"
          >
            <SettingsIcon fontSize="small" />
          </IconButton>
        ) : (
          <>
            <Typography className="palitras-control-title">Налаштування</Typography>
            <IconButton
              className="palitras-toggle-button map-settings-toggle-button"
              onClick={toggleCollapsed}
              aria-label="Згорнути"
              title="Згорнути"
              size="small"
            >
              <ExpandMoreIcon fontSize="small" />
            </IconButton>
          </>
        )}
      </Box>

      {!isCollapsed ? (
        <Box className="layer-switch-list">
          <Box className="palitra-main-row map-settings-item" onClick={toggleVisible}>
            <Checkbox
              className="palitra-checkbox map-settings-checkbox"
              checked={props.visible}
              onClick={(event) => {
                event.stopPropagation();
              }}
              onChange={() => {
                toggleVisible();
              }}
              size="small"
            />
            <Box
              className="palitra-title-button map-settings-item-label"
              title="Підписи пеленгів"
            >
              <Typography className="palitra-name map-settings-label">Підписи пеленгів</Typography>
            </Box>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

export function AnalysisMapSettingsControl(props: AnalysisMapSettingsControlProps) {
  const theme = useNeoMuiTheme();
  return (
    <ThemeProvider theme={theme}>
      <AnalysisMapSettingsControlInner {...props} />
    </ThemeProvider>
  );
}
