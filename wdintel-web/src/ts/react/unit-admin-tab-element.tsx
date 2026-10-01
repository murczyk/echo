import { createRoot, type Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { UnitActivityPanel, UnitInterceptionsPanel } from './routes/rer-unit-admin-tabs';

class UnitAdminTabElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-unit-id', 'data-tab'];
  }

  private renderRoot() {
    if (!this.root) return;
    const unitId = Number(this.getAttribute('data-unit-id'));
    const tab = this.getAttribute('data-tab');
    if (!Number.isSafeInteger(unitId) || unitId <= 0) {
      this.root.render(null);
      return;
    }
    const panel =
      tab === 'activity' ? (
        <UnitActivityPanel unitId={unitId} />
      ) : tab === 'interceptions' ? (
        <UnitInterceptionsPanel unitId={unitId} />
      ) : null;
    this.root.render(<NeoMuiThemeProvider>{panel}</NeoMuiThemeProvider>);
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.root = createRoot(this);
    }
    this.renderRoot();
  }

  attributeChangedCallback(_name: string, oldValue: string | null, newValue: string | null) {
    if (oldValue !== newValue) this.renderRoot();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('unit-admin-tab')) {
  customElements.define('unit-admin-tab', UnitAdminTabElement);
}
