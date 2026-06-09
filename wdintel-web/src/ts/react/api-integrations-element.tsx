import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { AdminApiIntegrationsPage } from './routes/admin-api-integrations';

function ApiIntegrationsRoot() {
  return (
    <NeoMuiThemeProvider>
      <AdminApiIntegrationsPage />
    </NeoMuiThemeProvider>
  );
}

class ApiIntegrationsElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.root = createRoot(this);
    }
    this.root.render(<ApiIntegrationsRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('api-integrations')) {
  customElements.define('api-integrations', ApiIntegrationsElement);
}
