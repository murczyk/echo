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

function RerNetworksNeoRoot({
  authUserRoles,
  unitId,
}: {
  authUserRoles: string[];
  unitId?: number;
}) {
  return (
    <NeoMuiThemeProvider>
      <RerNetworksNeoPage authUserRoles={authUserRoles} unitId={unitId} />
    </NeoMuiThemeProvider>
  );
}

class RerNetworksNeoElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-auth-user-roles', 'data-unit-id'];
  }

  private renderRoot() {
    if (!this.root) return;
    const authUserRoles = getAuthUserRolesFromShell(this);
    const unitIdAttribute = this.getAttribute('data-unit-id');
    const unitId = unitIdAttribute === null ? undefined : Number(unitIdAttribute);
    if (unitId !== undefined && (!Number.isSafeInteger(unitId) || unitId <= 0)) {
      this.root.render(<div role="alert">Некоректний ID підрозділу.</div>);
      return;
    }
    this.root.render(<RerNetworksNeoRoot authUserRoles={authUserRoles} unitId={unitId} />);
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
    if ((name === 'data-auth-user-roles' || name === 'data-unit-id') && oldValue !== newValue) {
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
