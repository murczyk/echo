import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { RerNetworkDetailsNeoPage } from './routes/rer-network-details-neo';

function readNetworkIdFromElement(element: Element): number | null {
  const raw = element.getAttribute('network-id')?.trim() ?? '';
  if (raw === '') return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function RerNetworkDetailsNeoRoot({ networkId }: { networkId: number | null }) {
  if (networkId === null) {
    return (
      <NeoMuiThemeProvider>
        <div className="p-6 text-sm text-red-700">Некоректний ID мережі.</div>
      </NeoMuiThemeProvider>
    );
  }

  return (
    <NeoMuiThemeProvider>
      <RerNetworkDetailsNeoPage networkId={networkId} />
    </NeoMuiThemeProvider>
  );
}

class RerNetworkDetailsNeoElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['network-id'];
  }

  private renderRoot() {
    if (!this.root) return;
    this.root.render(<RerNetworkDetailsNeoRoot networkId={readNetworkIdFromElement(this)} />);
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
    if (name === 'network-id' && oldValue !== newValue) {
      this.renderRoot();
    }
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('rer-network-details-neo')) {
  customElements.define('rer-network-details-neo', RerNetworkDetailsNeoElement);
}
