import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

import { PowerSnackbarProvider } from './components/PowerSnackbar';
import { NeoMuiThemeProvider } from './mui-theme';
import { AdminKpiPage } from './routes/admin-kpi';

class AdminKpiElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    this.root ??= createRoot(this);
    this.root.render(
      <NeoMuiThemeProvider>
        <PowerSnackbarProvider>
          <AdminKpiPage />
        </PowerSnackbarProvider>
      </NeoMuiThemeProvider>,
    );
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('admin-kpi')) {
  customElements.define('admin-kpi', AdminKpiElement);
}
