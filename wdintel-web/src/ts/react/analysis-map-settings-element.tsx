import React from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AnalysisMapSettingsControl } from './AnalysisMapSettingsControl';

class AnalysisMapSettingsElement extends HTMLElement {
  private root: Root | null = null;
  private visible = true;

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

  setPelengLabelsVisible(visible: boolean) {
    this.visible = visible;
    this.renderComponent();
  }

  private renderComponent() {
    if (!this.root) {
      return;
    }

    this.root.render(
      <AnalysisMapSettingsControl
        visible={this.visible}
        onVisibleChange={(visible) => {
          this.visible = visible;
          this.renderComponent();
          this.dispatchEvent(
            new CustomEvent('peleng-labels-visible-change', {
              detail: { visible },
              bubbles: true,
              composed: true,
            }),
          );
        }}
      />,
    );
  }
}

if (!customElements.get('analysis-map-settings')) {
  customElements.define('analysis-map-settings', AnalysisMapSettingsElement);
}
