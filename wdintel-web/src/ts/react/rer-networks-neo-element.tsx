import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { RerNetworksNeoPage } from './routes/rer-networks-neo';

function getAuthUserRolesFromShell(el: Element): string[] {
  const ownRaw = el.getAttribute('data-auth-user-roles') ?? '';
  if (ownRaw.trim() !== '') {
    return ownRaw
      .split(',')
      .map((role) => role.trim())
      .filter((role) => role.length > 0);
  }

  const shell = el.closest('.app-shell');
  const raw = shell?.getAttribute('data-auth-user-roles') ?? '';
  return raw
    .split(',')
    .map((role) => role.trim())
    .filter((role) => role.length > 0);
}

function RerNetworksNeoRoot({ authUserRoles }: { authUserRoles: string[] }) {
  return (
    <NeoMuiThemeProvider>
      <RerNetworksNeoPage authUserRoles={authUserRoles} />
    </NeoMuiThemeProvider>
  );
}

class RerNetworksNeoElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-auth-user-roles'];
  }

  private renderRoot() {
    if (!this.root) return;
    const authUserRoles = getAuthUserRolesFromShell(this);
    this.root.render(<RerNetworksNeoRoot authUserRoles={authUserRoles} />);
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
    if (name === 'data-auth-user-roles' && oldValue !== newValue) {
      this.renderRoot();
    }
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('rer-networks-neo')) {
  customElements.define('rer-networks-neo', RerNetworksNeoElement);
}
