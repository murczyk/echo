import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { AdminUnitDuplicatesPage } from './routes/admin-unit-duplicates';

function getAuthUserRolesFromShell(element: Element): string[] {
  const raw =
    element.getAttribute('data-auth-user-roles') ??
    element.closest('.app-shell')?.getAttribute('data-auth-user-roles') ??
    '';
  return raw
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
}

function AdminUnitDuplicatesRoot({ authUserRoles }: { authUserRoles: string[] }) {
  return (
    <NeoMuiThemeProvider>
      <AdminUnitDuplicatesPage authUserRoles={authUserRoles} />
    </NeoMuiThemeProvider>
  );
}

class AdminUnitDuplicatesElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-auth-user-roles'];
  }

  private renderRoot() {
    this.root?.render(<AdminUnitDuplicatesRoot authUserRoles={getAuthUserRolesFromShell(this)} />);
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

if (!customElements.get('admin-unit-duplicates')) {
  customElements.define('admin-unit-duplicates', AdminUnitDuplicatesElement);
}
