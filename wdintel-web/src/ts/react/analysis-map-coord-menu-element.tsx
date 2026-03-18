import React from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AnalysisMapCoordMenu } from './AnalysisMapCoordMenu';

const ATTR_LAT = 'lat';
const ATTR_LNG = 'lng';
const ATTR_MGRS = 'mgrs-coords';

class AnalysisMapCoordMenuElement extends HTMLElement {
  static observedAttributes = [ATTR_LAT, ATTR_LNG, ATTR_MGRS];

  private root: Root | null = null;
  private lat = 0;
  private lng = 0;
  private mgrsCoords: string | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }

    this.readAttributes();
    this.renderComponent();
  }

  attributeChangedCallback() {
    this.readAttributes();
    this.renderComponent();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }

  private readAttributes() {
    this.lat = parseNumber(this.getAttribute(ATTR_LAT));
    this.lng = parseNumber(this.getAttribute(ATTR_LNG));
    this.mgrsCoords = this.getAttribute(ATTR_MGRS);
  }

  private renderComponent() {
    if (!this.root) {
      return;
    }

    this.root.render(
      <AnalysisMapCoordMenu
        lat={this.lat}
        lng={this.lng}
        mgrsCoords={this.mgrsCoords}
        onClose={() => {
          this.dispatchEvent(new CustomEvent('coord-menu-close', { bubbles: true, composed: true }));
        }}
      />,
    );

    requestAnimationFrame(() => {
      this.dispatchEvent(new CustomEvent('coord-menu-rendered', { bubbles: true, composed: true }));
    });
  }
}

function parseNumber(raw: string | null): number {
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

if (!customElements.get('analysis-map-coord-menu')) {
  customElements.define('analysis-map-coord-menu', AnalysisMapCoordMenuElement);
}
