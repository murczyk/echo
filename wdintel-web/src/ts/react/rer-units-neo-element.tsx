import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { RerUnitsNeoPage } from './routes/rer-units-neo';

function getAuthUserRolesFromShell(el: Element): string[] {
  const ownRaw = el.getAttribute('data-auth-user-roles') ?? '';
  if (ownRaw.trim() !== '') {
    return ownRaw
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean);
  }

  const raw = el.closest('.app-shell')?.getAttribute('data-auth-user-roles') ?? '';
  return raw
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
}

function RerUnitsNeoRoot({
  authUserRoles,
  openCreate,
}: {
  authUserRoles: string[];
  openCreate: boolean;
}) {
  return (
    <NeoMuiThemeProvider>
      <RerUnitsNeoPage authUserRoles={authUserRoles} openCreate={openCreate} />
    </NeoMuiThemeProvider>
  );
}

class RerUnitsNeoElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-auth-user-roles', 'data-open-create'];
  }

  private renderRoot() {
    if (!this.root) return;
    this.root.render(
      <RerUnitsNeoRoot
        authUserRoles={getAuthUserRolesFromShell(this)}
        openCreate={this.getAttribute('data-open-create') === 'true'}
      />,
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
    if ((name === 'data-auth-user-roles' || name === 'data-open-create') && oldValue !== newValue) {
      this.renderRoot();
    }
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('rer-units-neo')) {
  customElements.define('rer-units-neo', RerUnitsNeoElement);
}
