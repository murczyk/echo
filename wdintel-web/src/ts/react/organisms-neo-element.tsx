import { OrganismManagementContext } from './routes/admin-organisms-neo/management-context';
import { hasRole } from './utils/roles';
import { PowerSnackbarProvider } from './components/PowerSnackbar';
import { PowerAlert } from './components/PowerAlert';
import { createRoot, Root } from 'react-dom/client';

import { AdminOrganismsNeoPage } from './routes/admin-organisms-neo';
import { NeoMuiThemeProvider } from './mui-theme';

function OrganismsNeoRoot({ roles }: { roles: string[] }) {
  return (
    <NeoMuiThemeProvider>
      <PowerSnackbarProvider>
        <OrganismManagementContext.Provider value={{ globalAdmin: hasRole(roles, 'Admin') }}>
          {hasRole(roles, 'OrganismAdmin') ? (
            <AdminOrganismsNeoPage />
          ) : (
            <PowerAlert severity="error">Немає доступу до організмів.</PowerAlert>
          )}
        </OrganismManagementContext.Provider>
      </PowerSnackbarProvider>
    </NeoMuiThemeProvider>
  );
}

class OrganismsNeoElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-auth-user-id', 'data-auth-user-roles'];
  }

  attributeChangedCallback() {
    this.render();
  }

  private render() {
    const roles = this.getAttribute('data-auth-user-roles')?.split(',') ?? [];
    this.root?.render(
      <OrganismsNeoRoot
        key={`${this.getAttribute('data-auth-user-id')}:${roles.join(',')}`}
        roles={roles}
      />,
    );
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.root = createRoot(this);
    }
    this.render();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('organisms-neo')) {
  customElements.define('organisms-neo', OrganismsNeoElement);
}
