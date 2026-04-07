import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { AdminGoiIntegrationsNeoPage } from './routes/admin-goi-integrations-neo';

function GoiIntegrationsNeoRoot() {
  return (
    <NeoMuiThemeProvider>
      <AdminGoiIntegrationsNeoPage />
    </NeoMuiThemeProvider>
  );
}

class GoiIntegrationsNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.root = createRoot(this);
    }

    this.root.render(<GoiIntegrationsNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('goi-integrations-neo')) {
  customElements.define('goi-integrations-neo', GoiIntegrationsNeoElement);
}
