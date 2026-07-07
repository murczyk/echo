import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { DevicesPage } from './routes/devices';

function readAuthUserRoles(element: Element): string[] {
  const ownRaw = element.getAttribute('data-auth-user-roles') ?? '';
  if (ownRaw.trim() !== '') {
    return splitRoles(ownRaw);
  }

  const shell = element.closest('.app-shell');
  return splitRoles(shell?.getAttribute('data-auth-user-roles') ?? '');
}

function splitRoles(raw: string): string[] {
  return raw
    .split(',')
    .map((role) => role.trim())
    .filter((role) => role.length > 0);
}

function DevicesPageRoot({ authUserRoles }: { authUserRoles: string[] }) {
  return (
    <NeoMuiThemeProvider>
      <DevicesPage authUserRoles={authUserRoles} />
    </NeoMuiThemeProvider>
  );
}

class DevicesPageElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-auth-user-roles'];
  }

  private renderRoot() {
    if (!this.root) return;
    this.root.render(<DevicesPageRoot authUserRoles={readAuthUserRoles(this)} />);
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.style.minHeight = '0';
      this.style.minWidth = '0';
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

if (!customElements.get('devices-page')) {
  customElements.define('devices-page', DevicesPageElement);
}
