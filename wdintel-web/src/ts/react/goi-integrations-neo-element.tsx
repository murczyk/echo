import { OrganismManagementContext } from './routes/admin-organisms-neo/management-context';
import { hasRole } from './utils/roles';
import { PowerAlert } from './components/PowerAlert';
import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { AdminGoiIntegrationsNeoPage } from './routes/admin-goi-integrations-neo';

function GoiIntegrationsNeoRoot({ roles }: { roles: string[] }) {
  return (
    <NeoMuiThemeProvider>
      <OrganismManagementContext.Provider value={{ globalAdmin: hasRole(roles, 'Admin') }}>
        {hasRole(roles, 'Admin') ? (
          <AdminGoiIntegrationsNeoPage />
        ) : (
          <PowerAlert severity="error">Немає доступу до ГОІ.</PowerAlert>
        )}
      </OrganismManagementContext.Provider>
    </NeoMuiThemeProvider>
  );
}

class GoiIntegrationsNeoElement extends HTMLElement {
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
      <GoiIntegrationsNeoRoot
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

if (!customElements.get('goi-integrations-neo')) {
  customElements.define('goi-integrations-neo', GoiIntegrationsNeoElement);
}
