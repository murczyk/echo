import { createRoot, type Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { CreateDeviceNetworkDialog } from './routes/rer-unit-details/CreateDeviceNetworkDialog';

function parseUnitId(element: Element): number | null {
  const unitId = Number(element.getAttribute('data-unit-id'));
  return Number.isInteger(unitId) && unitId > 0 ? unitId : null;
}

function parseUnitMask(element: Element): string[] {
  try {
    const value: unknown = JSON.parse(element.getAttribute('data-unit-mask') ?? '[]');
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

class DeviceNetworkCreateDialogElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-unit-id', 'data-unit-name', 'data-unit-mask'];
  }

  private dispatchDialogEvent(name: string) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }

  private renderRoot() {
    if (!this.root) return;
    const unitId = parseUnitId(this);
    if (unitId === null) {
      this.root.render(null);
      return;
    }
    const unitName = this.getAttribute('data-unit-name') ?? '';
    const defaultUnitMask = parseUnitMask(this);
    this.root.render(
      <NeoMuiThemeProvider>
        <CreateDeviceNetworkDialog
          key={unitId}
          unitId={unitId}
          unitName={unitName}
          defaultUnitMask={defaultUnitMask}
          onClose={() => this.dispatchDialogEvent('device-network-create-close')}
          onCreated={() => this.dispatchDialogEvent('device-network-created')}
        />
      </NeoMuiThemeProvider>,
    );
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }
    this.renderRoot();
  }

  attributeChangedCallback(_name: string, oldValue: string | null, newValue: string | null) {
    if (oldValue !== newValue) this.renderRoot();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('device-network-create-dialog')) {
  customElements.define('device-network-create-dialog', DeviceNetworkCreateDialogElement);
}
