import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import LayersIcon from '@mui/icons-material/Layers';
import { Badge, Box, Checkbox, IconButton, Radio, ThemeProvider, Typography } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';

import type { FeatureToggleState } from '../maps/control-modules';
import { BaseLayerId } from '../maps/base-layers';
import { useNeoMuiTheme } from './mui-theme';

type AnalysisMapLayerSwitchControlProps = {
  currentLayer: BaseLayerId;
  features: FeatureToggleState;
  forceCollapsed?: boolean;
  onLayerChange: (layer: BaseLayerId) => void;
  onFeatureToggle: (feature: keyof FeatureToggleState, enabled: boolean) => void;
};

const STORAGE_KEY = 'layer-control-collapsed';

function AnalysisMapLayerSwitchControlInner(props: AnalysisMapLayerSwitchControlProps) {
  const showLayersBadge = !props.features.pelengsEnabled;
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

  useEffect(() => {
    if (props.forceCollapsed) {
      setCollapsed(true);
      return;
    }
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      setCollapsed(saved === null ? true : saved === 'true');
    } catch {
      setCollapsed(true);
    }
  }, [props.forceCollapsed]);

  return (
    <Box className={`palitras-control layer-switch-control ${isCollapsed ? 'collapsed' : ''}`}>
      <Box className="palitras-control-header">
        {isCollapsed ? (
          <Badge
            color="error"
            variant="dot"
            invisible={!showLayersBadge}
            overlap="circular"
            className="layer-switch-toggle-badge"
          >
            <IconButton
              className="palitras-palette-icon layer-switch-toggle-icon"
              onClick={toggleCollapsed}
              aria-label="Розгорнути список шарів"
              title="Розгорнути список шарів"
              size="small"
            >
              <LayersIcon fontSize="small" />
            </IconButton>
          </Badge>
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
          <LayerRow
            checked={props.features.palitrasEnabled}
            label="Палітри"
            onClick={() =>
              props.onFeatureToggle('palitrasEnabled', !props.features.palitrasEnabled)
            }
            type="checkbox"
          />
          <LayerRow
            checked={props.features.pelengsEnabled}
            label="Пеленги"
            onClick={() => props.onFeatureToggle('pelengsEnabled', !props.features.pelengsEnabled)}
            type="checkbox"
          />
          <LayerRow
            checked={props.features.deltaKmlEnabled}
            label="Delta KML"
            onClick={() =>
              props.onFeatureToggle('deltaKmlEnabled', !props.features.deltaKmlEnabled)
            }
            type="checkbox"
          />
          <Typography className="layer-switch-subheader">Основа</Typography>
          <LayerRow
            checked={props.currentLayer === BaseLayerId.Delta}
            label="Delta"
            onClick={() => props.onLayerChange(BaseLayerId.Delta)}
            type="radio"
          />
          <LayerRow
            checked={props.currentLayer === BaseLayerId.Google}
            label="Google"
            onClick={() => props.onLayerChange(BaseLayerId.Google)}
            type="radio"
          />
          <LayerRow
            checked={props.currentLayer === BaseLayerId.OpenStreetMap}
            label="OpenStreetMap"
            onClick={() => props.onLayerChange(BaseLayerId.OpenStreetMap)}
            type="radio"
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
