import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { AdminUnparsedUnitsPage } from './routes/admin-unparsed-units';

class AdminUnparsedUnitsElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-title'];
  }

  private renderRoot() {
    this.root?.render(
      <NeoMuiThemeProvider>
        <AdminUnparsedUnitsPage title={this.getAttribute('data-title') ?? ''} />
      </NeoMuiThemeProvider>,
    );
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.style.minHeight = '0';
      this.root = createRoot(this);
    }
    this.renderRoot();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (name === 'data-title' && oldValue !== newValue) this.renderRoot();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('admin-unparsed-units')) {
  customElements.define('admin-unparsed-units', AdminUnparsedUnitsElement);
}
