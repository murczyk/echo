import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { RerCallsignsNeoPage } from './routes/rer-callsigns-neo';

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

function RerCallsignsNeoRoot({ authUserRoles }: { authUserRoles: string[] }) {
  return (
    <NeoMuiThemeProvider>
      <RerCallsignsNeoPage authUserRoles={authUserRoles} />
    </NeoMuiThemeProvider>
  );
}

class RerCallsignsNeoElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-auth-user-roles'];
  }

  private renderRoot() {
    if (!this.root) return;
    const authUserRoles = getAuthUserRolesFromShell(this);
    this.root.render(<RerCallsignsNeoRoot authUserRoles={authUserRoles} />);
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
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

if (!customElements.get('rer-callsigns-neo')) {
  customElements.define('rer-callsigns-neo', RerCallsignsNeoElement);
}
