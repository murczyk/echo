
import { createRoot, Root } from 'react-dom/client';

import type { FeatureToggleState } from '../maps/control-modules';
import { AnalysisMapLayerSwitchControl } from './AnalysisMapLayerSwitchControl';

type BaseLayerName = 'openStreetMap' | 'googleHybrid';

class AnalysisMapLayerSwitchElement extends HTMLElement {
  private root: Root | null = null;
  private currentLayer: BaseLayerName = 'googleHybrid';
  private features: FeatureToggleState = {
    palitrasEnabled: true,
    kmzEnabled: true,
    pelengsEnabled: true,
  };

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }
    this.renderComponent();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }

  setCurrentLayer(currentLayer: BaseLayerName) {
    this.currentLayer = currentLayer;
    this.renderComponent();
  }

  setFeatures(features: FeatureToggleState) {
    this.features = features;
    this.renderComponent();
  }

  private renderComponent() {
    if (!this.root) {
      return;
    }

    this.root.render(
      <AnalysisMapLayerSwitchControl
        currentLayer={this.currentLayer}
        features={this.features}
        onLayerChange={(layer) => {
          this.currentLayer = layer;
          this.renderComponent();
          this.dispatchEvent(
            new CustomEvent('analysis-map-layer-change', {
              detail: { layer },
              bubbles: true,
              composed: true,
            }),
          );
        }}
        onFeatureToggle={(feature, enabled) => {
          this.features = { ...this.features, [feature]: enabled };
          this.renderComponent();
          this.dispatchEvent(
            new CustomEvent('analysis-map-feature-toggle', {
              detail: { feature, enabled },
              bubbles: true,
              composed: true,
            }),
          );
        }}
      />,
    );
  }
}

if (!customElements.get('analysis-map-layer-switch')) {
  customElements.define('analysis-map-layer-switch', AnalysisMapLayerSwitchElement);
}
