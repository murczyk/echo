import { OrganismManagementContext } from './routes/admin-organisms-neo/management-context';
import { hasRole } from './utils/roles';
import { PowerSnackbarProvider } from './components/PowerSnackbar';
import { PowerAlert } from './components/PowerAlert';
import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { AdminOrganismsNeoEditPage } from './routes/admin-organisms-neo-edit';
import { useNeoMuiTheme } from './mui-theme';

function OrganismsNeoEditRoot(props: {
  organismId: string | null;
  roles: string[];
  canManage: boolean;
}) {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <PowerSnackbarProvider>
        <OrganismManagementContext.Provider value={{ globalAdmin: hasRole(props.roles, 'Admin') }}>
          {props.canManage ? (
            <AdminOrganismsNeoEditPage organismId={props.organismId} />
          ) : (
            <PowerAlert severity="error">Немає доступу до організмів.</PowerAlert>
          )}
        </OrganismManagementContext.Provider>
      </PowerSnackbarProvider>
    </ThemeProvider>
  );
}

class OrganismsNeoEditElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return [
      'data-organism-id',
      'data-auth-user-id',
      'data-auth-user-roles',
      'data-can-manage-organisms',
    ];
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }

    this.render();
  }

  attributeChangedCallback() {
    this.render();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }

  private render() {
    if (!this.root) return;
    const organismId = this.getAttribute('data-organism-id');
    const roles = this.getAttribute('data-auth-user-roles')?.split(',') ?? [];
    this.root.render(
      <OrganismsNeoEditRoot
        key={`${this.getAttribute('data-auth-user-id')}:${roles.join(',')}:${this.getAttribute('data-can-manage-organisms')}`}
        organismId={organismId}
        roles={roles}
        canManage={this.getAttribute('data-can-manage-organisms') === 'true'}
      />,
    );
  }
}

if (!customElements.get('organisms-neo-edit')) {
  customElements.define('organisms-neo-edit', OrganismsNeoEditElement);
}
