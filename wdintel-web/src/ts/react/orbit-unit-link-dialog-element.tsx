import { createRoot, type Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { OrbitUnitLinkDialog } from './routes/rer-unit-details/OrbitUnitLinkDialog';

function parseUnitId(element: Element): number | null {
  const unitId = Number(element.getAttribute('data-unit-id'));
  return Number.isInteger(unitId) && unitId > 0 ? unitId : null;
}

class OrbitUnitLinkDialogElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-unit-id'];
  }

  private dispatchClose = () => {
    this.dispatchEvent(
      new CustomEvent('orbit-unit-link-close', {
        bubbles: true,
        composed: true,
      }),
    );
  };

  private dispatchLinked = () => {
    this.dispatchEvent(
      new CustomEvent('orbit-unit-linked', {
        bubbles: true,
        composed: true,
      }),
    );
  };

  private renderRoot() {
    if (!this.root) return;
    const unitId = parseUnitId(this);
    if (unitId === null) {
      this.root.render(null);
      return;
    }
    this.root.render(
      <NeoMuiThemeProvider>
        <OrbitUnitLinkDialog
          key={unitId}
          unitId={unitId}
          onClose={this.dispatchClose}
          onLinked={this.dispatchLinked}
        />
      </NeoMuiThemeProvider>,
    );
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }
    this.renderRoot();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (name === 'data-unit-id' && oldValue !== newValue) {
      this.renderRoot();
    }
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('orbit-unit-link-dialog')) {
  customElements.define('orbit-unit-link-dialog', OrbitUnitLinkDialogElement);
}
