import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';

const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function readDeviceIdFromElement(element: Element): string | null {
  const raw = element.getAttribute('device-id')?.trim() ?? '';
  return DEVICE_ID_PATTERN.test(raw) ? raw : null;
}

function DeviceDetailsPageRoot({
  authUserRoles,
  deviceId,
}: {
  authUserRoles: string[];
  deviceId: string | null;
}) {
  if (deviceId === null) {
    return (
      <NeoMuiThemeProvider>
        <div className="p-6 text-sm text-red-700">Некоректний ID пристрою.</div>
      </NeoMuiThemeProvider>
    );
  }

  return (
    <NeoMuiThemeProvider>
      <div
        className="h-full w-full min-w-0 p-6"
        data-auth-user-roles={authUserRoles.join(',')}
        data-device-id={deviceId}
      >
        <h1 className="m-0 text-2xl font-semibold text-[var(--color-text)]">Пристрій</h1>
      </div>
    </NeoMuiThemeProvider>
  );
}

class DeviceDetailsPageElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['device-id', 'data-auth-user-roles'];
  }

  private renderRoot() {
    if (!this.root) return;
    this.root.render(
      <DeviceDetailsPageRoot
        authUserRoles={readAuthUserRoles(this)}
        deviceId={readDeviceIdFromElement(this)}
      />,
    );
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
    if ((name === 'device-id' || name === 'data-auth-user-roles') && oldValue !== newValue) {
      this.renderRoot();
    }
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('device-details-page')) {
  customElements.define('device-details-page', DeviceDetailsPageElement);
}
