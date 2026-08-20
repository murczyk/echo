import { createRoot, Root } from 'react-dom/client';

import { AnalysisMapSettingsControl } from './AnalysisMapSettingsControl';

class AnalysisMapSettingsElement extends HTMLElement {
  private root: Root | null = null;
  private visible = true;
  private forceCollapsed = false;
  private canShowSettlements = false;
  private showSettlements = false;
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

  setSettlementVisibility(canShow: boolean, show: boolean) {
    this.canShowSettlements = canShow;
    this.showSettlements = canShow && show;
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
        canShowSettlements={this.canShowSettlements}
        showSettlements={this.showSettlements}
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
        onShowSettlementsChange={(show) => {
          this.showSettlements = this.canShowSettlements && show;
          this.renderComponent();
          this.dispatchEvent(
            new CustomEvent('show-settlements-change', {
              detail: { show: this.showSettlements },
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
