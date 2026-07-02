import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

import { AnalysisMapWindowControl } from './AnalysisMapWindowControl';

class AnalysisMapWindowControlElement extends HTMLElement {
  private root: Root | null = null;
  private isFullscreen = false;
  private showFullscreen = true;
  private pendingUnmountHandle: number | null = null;

  static get observedAttributes() {
    return ['show-fullscreen'];
  }

  connectedCallback() {
    this.showFullscreen = this.getAttribute('show-fullscreen') !== 'false';
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

  attributeChangedCallback() {
    this.showFullscreen = this.getAttribute('show-fullscreen') !== 'false';
    this.renderComponent();
  }

  setFullscreen(isFullscreen: boolean) {
    this.isFullscreen = isFullscreen;
    this.renderComponent();
  }

  private renderComponent() {
    if (!this.root) {
      return;
    }

    this.root.render(
      <AnalysisMapWindowControl
        isFullscreen={this.isFullscreen}
        onZoomIn={() => {
          this.dispatchEvent(
            new CustomEvent('analysis-map-zoom-in', { bubbles: true, composed: true }),
          );
        }}
        onZoomOut={() => {
          this.dispatchEvent(
            new CustomEvent('analysis-map-zoom-out', { bubbles: true, composed: true }),
          );
        }}
        onToggleFullscreen={() => {
          this.isFullscreen = !this.isFullscreen;
          this.renderComponent();
          this.dispatchEvent(
            new CustomEvent('analysis-map-toggle-fullscreen', {
              detail: { fullscreen: this.isFullscreen },
              bubbles: true,
              composed: true,
            }),
          );
        }}
        showFullscreen={this.showFullscreen}
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

if (!customElements.get('analysis-map-window-control')) {
  customElements.define('analysis-map-window-control', AnalysisMapWindowControlElement);
}
