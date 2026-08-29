import { createRoot, Root } from 'react-dom/client';

import type { FeatureToggleState } from '../maps/control-modules';
import { DEFAULT_BASE_LAYER_ID, type BaseLayerId } from '../maps/base-layers';
import { AnalysisMapLayerSwitchControl } from './AnalysisMapLayerSwitchControl';

class AnalysisMapLayerSwitchElement extends HTMLElement {
  private root: Root | null = null;
  private currentLayer: BaseLayerId = DEFAULT_BASE_LAYER_ID;
  private forceCollapsed = false;
  private pendingUnmountHandle: number | null = null;
  private features: FeatureToggleState = {
    palitrasEnabled: true,
    deltaKmlEnabled: true,
    pelengsEnabled: true,
  };

  connectedCallback() {
    if (this.pendingUnmountHandle !== null) {
      window.clearTimeout(this.pendingUnmountHandle);
      this.pendingUnmountHandle = null;
    }

    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }
    this.renderComponent();
  }

  disconnectedCallback() {
    this.scheduleRootUnmount();
  }

  setCurrentLayer(currentLayer: BaseLayerId) {
    this.currentLayer = currentLayer;
    this.renderComponent();
  }

  setFeatures(features: FeatureToggleState) {
    this.features = features;
    this.renderComponent();
  }

  setCollapsed(collapsed: boolean) {
    this.forceCollapsed = collapsed;
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
        forceCollapsed={this.forceCollapsed}
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

  private scheduleRootUnmount() {
    if (this.pendingUnmountHandle !== null) {
      return;
    }

    const root = this.root;
    if (!root) {
      return;
    }

    this.pendingUnmountHandle = window.setTimeout(() => {
      this.pendingUnmountHandle = null;

      if (this.isConnected || this.root !== root) {
        return;
      }

      root.unmount();
      this.root = null;
    }, 0);
  }
}

if (!customElements.get('analysis-map-layer-switch')) {
  customElements.define('analysis-map-layer-switch', AnalysisMapLayerSwitchElement);
}
