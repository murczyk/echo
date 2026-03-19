import CloseIcon from '@mui/icons-material/Close';
import { IconButton } from '@mui/material';
import * as L from 'leaflet';
import React from 'react';
import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from '../react/mui-theme';
import { Palitra } from './palitra-types';

type PopupLayer = L.Layer & { closePopup: () => void; _popupCloseRoot?: Root };

export function buildPalitraPopupContent(
  layer: PopupLayer,
  palitra: Palitra,
  details: {
    emphasisLine?: { label: string; value: string } | null;
    metaLines?: string[];
  },
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'analysis-map-compact-popup analysis-map-palitra-popup';

  const header = document.createElement('div');
  header.className = 'analysis-map-compact-popup__header';

  const swatch = document.createElement('span');
  swatch.className = 'analysis-map-palitra-popup__swatch';
  swatch.style.backgroundColor = palitra.color_hex;
  header.appendChild(swatch);

  const title = document.createElement('strong');
  title.className = 'analysis-map-compact-popup__title';
  title.textContent = palitra.name;
  title.title = palitra.name;
  header.appendChild(title);

  const closeHost = document.createElement('div');
  closeHost.className = 'analysis-map-compact-popup__close-host';
  header.appendChild(closeHost);
  container.appendChild(header);

  if (details.emphasisLine) {
    const line = document.createElement('div');
    line.className = 'analysis-map-compact-popup__line';
    const label = document.createElement('strong');
    label.textContent = `${details.emphasisLine.label}: `;
    line.appendChild(label);
    line.append(details.emphasisLine.value);
    line.title = `${details.emphasisLine.label}: ${details.emphasisLine.value}`;
    container.appendChild(line);
  }

  if (details.metaLines && details.metaLines.length > 0) {
    const meta = document.createElement('div');
    meta.className = 'analysis-map-compact-popup__meta-group';
    details.metaLines.forEach((metaLine) => {
      const row = document.createElement('div');
      row.className = 'analysis-map-compact-popup__meta';
      row.textContent = metaLine;
      row.title = metaLine;
      meta.appendChild(row);
    });
    container.appendChild(meta);
  }

  const mountCloseButton = () => {
    if (layer._popupCloseRoot) {
      return;
    }

    const root = createRoot(closeHost);
    layer._popupCloseRoot = root;
    root.render(
      React.createElement(
        NeoMuiThemeProvider,
        null,
        React.createElement(
          IconButton,
          {
            'aria-label': 'Закрити',
            size: 'small',
            onClick: () => layer.closePopup(),
            sx: {
              width: 28,
              height: 28,
              borderRadius: 1.25,
              color: 'rgba(255, 255, 255, 0.92)',
              '&:hover': {
                bgcolor: 'rgba(255, 255, 255, 0.08)',
              },
              '&.Mui-focusVisible': {
                outline: 'none',
                boxShadow: 'none',
              },
            },
          },
          React.createElement(CloseIcon, { fontSize: 'small' }),
        ),
      ),
    );
  };

  const cleanup = () => {
    layer._popupCloseRoot?.unmount();
    layer._popupCloseRoot = undefined;
  };
  layer.on?.('popupopen', mountCloseButton);
  layer.on?.('popupclose', cleanup);
  layer.on?.('remove', cleanup);

  return container;
}
