import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import LayersIcon from '@mui/icons-material/Layers';
import { Box, Checkbox, IconButton, Radio, ThemeProvider, Typography } from '@mui/material';
import { useCallback, useState } from 'react';

import type { FeatureToggleState } from '../maps/control-modules';
import { useNeoMuiTheme } from './mui-theme';

type BaseLayerName = 'openStreetMap' | 'googleHybrid';

type AnalysisMapLayerSwitchControlProps = {
  currentLayer: BaseLayerName;
  features: FeatureToggleState;
  onLayerChange: (layer: BaseLayerName) => void;
  onFeatureToggle: (feature: keyof FeatureToggleState, enabled: boolean) => void;
};

const STORAGE_KEY = 'layer-control-collapsed';

function AnalysisMapLayerSwitchControlInner(props: AnalysisMapLayerSwitchControlProps) {
  const [isCollapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return (
    <Box className={`palitras-control layer-switch-control ${isCollapsed ? 'collapsed' : ''}`}>
      <Box className="palitras-control-header">
        {isCollapsed ? (
          <IconButton
            className="palitras-palette-icon layer-switch-toggle-icon"
            onClick={toggleCollapsed}
            aria-label="Розгорнути список шарів"
            title="Розгорнути список шарів"
            size="small"
          >
            <LayersIcon fontSize="small" />
          </IconButton>
        ) : (
          <>
            <Typography className="palitras-control-title">Шари</Typography>
            <IconButton
              className="palitras-toggle-button layer-switch-collapse-button"
              onClick={toggleCollapsed}
              aria-label="Згорнути список шарів"
              title="Згорнути список шарів"
              size="small"
            >
              <ExpandMoreIcon fontSize="small" />
            </IconButton>
          </>
        )}
      </Box>

      {!isCollapsed ? (
        <Box className="layer-switch-list">
          <Typography className="layer-switch-subheader">Базова мапа</Typography>
          <LayerRow
            checked={props.currentLayer === 'openStreetMap'}
            label="OpenStreetMap"
            onClick={() => props.onLayerChange('openStreetMap')}
            type="radio"
          />
          <LayerRow
            checked={props.currentLayer === 'googleHybrid'}
            label="Супутник"
            onClick={() => props.onLayerChange('googleHybrid')}
            type="radio"
          />

          <Typography className="layer-switch-subheader">Шари</Typography>
          <LayerRow
            checked={props.features.palitrasEnabled}
            label="Палітри"
            onClick={() => props.onFeatureToggle('palitrasEnabled', !props.features.palitrasEnabled)}
            type="checkbox"
          />
          <LayerRow
            checked={props.features.pelengsEnabled}
            label="Пеленги"
            onClick={() => props.onFeatureToggle('pelengsEnabled', !props.features.pelengsEnabled)}
            type="checkbox"
          />
          <LayerRow
            checked={props.features.kmzEnabled}
            label="KMZ підкладка"
            onClick={() => props.onFeatureToggle('kmzEnabled', !props.features.kmzEnabled)}
            type="checkbox"
          />
        </Box>
      ) : null}
    </Box>
  );
}

function LayerRow(props: {
  checked: boolean;
  label: string;
  onClick: () => void;
  type: 'radio' | 'checkbox';
}) {
  return (
    <Box className="palitra-main-row layer-switch-item" onClick={props.onClick}>
      {props.type === 'checkbox' ? (
        <Checkbox
          checked={props.checked}
          className="palitra-checkbox layer-switch-checkbox"
          size="small"
          onClick={(event) => {
            event.stopPropagation();
          }}
          onChange={() => {
            props.onClick();
          }}
        />
      ) : (
        <Radio
          checked={props.checked}
          className="palitra-checkbox layer-switch-checkbox"
          size="small"
          onClick={(event) => {
            event.stopPropagation();
          }}
          onChange={() => {
            props.onClick();
          }}
        />
      )}
      <Box className="palitra-title-button layer-switch-item-label" title={props.label}>
        <Typography className="palitra-name layer-switch-label">{props.label}</Typography>
      </Box>
    </Box>
  );
}

export function AnalysisMapLayerSwitchControl(props: AnalysisMapLayerSwitchControlProps) {
  const theme = useNeoMuiTheme();
  return (
    <ThemeProvider theme={theme}>
      <AnalysisMapLayerSwitchControlInner {...props} />
    </ThemeProvider>
  );
}
