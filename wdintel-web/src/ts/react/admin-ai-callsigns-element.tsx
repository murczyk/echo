import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { PowerSnackbarProvider } from './components/PowerSnackbar';
import { AdminAiCallsignsPage } from './routes/admin-ai-callsigns';

function AdminAiCallsignsRoot() {
  return (
    <NeoMuiThemeProvider>
      <PowerSnackbarProvider>
        <AdminAiCallsignsPage />
      </PowerSnackbarProvider>
    </NeoMuiThemeProvider>
  );
}

class AdminAiCallsignsElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.root = createRoot(this);
    }
    this.root.render(<AdminAiCallsignsRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('admin-ai-callsigns')) {
  customElements.define('admin-ai-callsigns', AdminAiCallsignsElement);
}
