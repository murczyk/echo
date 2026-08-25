import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { AdminUnitsPage } from './routes/admin-units';

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

function AdminUnitsRoot({ authUserRoles }: { authUserRoles: string[] }) {
  return (
    <NeoMuiThemeProvider>
      <AdminUnitsPage authUserRoles={authUserRoles} />
    </NeoMuiThemeProvider>
  );
}

class AdminUnitsElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-auth-user-roles'];
  }

  private renderRoot() {
    this.root?.render(<AdminUnitsRoot authUserRoles={getAuthUserRoles(this)} />);
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

if (!customElements.get('admin-units')) {
  customElements.define('admin-units', AdminUnitsElement);
}
