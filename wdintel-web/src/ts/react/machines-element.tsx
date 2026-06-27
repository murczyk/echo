import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { MachinesPage } from './routes/machines';

function rolesFrom(el: Element): string[] {
  const raw = el.getAttribute('data-auth-user-roles') ?? '';
  return raw
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
}

function UnitMachinesRoot({ authUserRoles }: { authUserRoles: string[] }) {
  return (
    <NeoMuiThemeProvider>
      <MachinesPage authUserRoles={authUserRoles} />
    </NeoMuiThemeProvider>
  );
}

class UnitMachinesElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-auth-user-roles'];
  }

  private renderRoot() {
    this.root?.render(<UnitMachinesRoot authUserRoles={rolesFrom(this)} />);
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

  attributeChangedCallback() {
    this.renderRoot();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('unit-machines')) {
  customElements.define('unit-machines', UnitMachinesElement);
}
