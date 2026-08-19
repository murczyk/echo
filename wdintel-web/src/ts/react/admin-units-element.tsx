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

class AdminUnitsElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    this.style.display = 'block';
    this.style.width = '100%';
    this.style.height = '100%';
    this.style.minHeight = '0';
    this.root = createRoot(this);
    this.root.render(
      <NeoMuiThemeProvider>
        <AdminUnitsPage authUserRoles={getAuthUserRoles(this)} />
      </NeoMuiThemeProvider>,
    );
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('admin-units')) {
  customElements.define('admin-units', AdminUnitsElement);
}
