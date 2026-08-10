import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { AdminUnitUnparsedPage } from './routes/admin-unit-unparsed';

function getAuthUserRoles(element: Element): string[] {
  const raw =
    element.getAttribute('data-auth-user-roles') ??
    element.closest('.app-shell')?.getAttribute('data-auth-user-roles') ??
    '';
  return raw
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
}

class AdminUnitUnparsedElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-auth-user-roles'];
  }

  private renderRoot() {
    this.root?.render(
      <NeoMuiThemeProvider>
        <AdminUnitUnparsedPage authUserRoles={getAuthUserRoles(this)} />
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
    if (name === 'data-auth-user-roles' && oldValue !== newValue) this.renderRoot();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('admin-unit-unparsed')) {
  customElements.define('admin-unit-unparsed', AdminUnitUnparsedElement);
}
