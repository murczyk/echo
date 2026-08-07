import { createRoot, Root } from 'react-dom/client';

import { PowerSnackbarProvider } from './components/PowerSnackbar';
import { NeoMuiThemeProvider } from './mui-theme';
import { AdminDeviceAnalyticsPage } from './routes/admin-device-analytics';

function AdminDeviceAnalyticsRoot() {
  return (
    <NeoMuiThemeProvider>
      <PowerSnackbarProvider>
        <AdminDeviceAnalyticsPage />
      </PowerSnackbarProvider>
    </NeoMuiThemeProvider>
  );
}

class AdminDeviceAnalyticsElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.root = createRoot(this);
    }
    this.root.render(<AdminDeviceAnalyticsRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('admin-device-analytics')) {
  customElements.define('admin-device-analytics', AdminDeviceAnalyticsElement);
}
