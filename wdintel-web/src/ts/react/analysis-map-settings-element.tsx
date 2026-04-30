
import { createRoot, Root } from 'react-dom/client';

import { AnalysisMapSettingsControl } from './AnalysisMapSettingsControl';

class AnalysisMapSettingsElement extends HTMLElement {
  private root: Root | null = null;
  private visible = true;
  private forceCollapsed = false;
  private pendingUnmountHandle: number | null = null;

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

  setPelengLabelsVisible(visible: boolean) {
    this.visible = visible;
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
      <AnalysisMapSettingsControl
        visible={this.visible}
        forceCollapsed={this.forceCollapsed}
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

if (!customElements.get('analysis-map-settings')) {
  customElements.define('analysis-map-settings', AnalysisMapSettingsElement);
}
