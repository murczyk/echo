import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { AdminEchoMissingMessagesPage } from './routes/admin-echo-missing-messages';

function AdminEchoMissingMessagesRoot() {
  return (
    <NeoMuiThemeProvider>
      <AdminEchoMissingMessagesPage />
    </NeoMuiThemeProvider>
  );
}

class AdminEchoMissingMessagesElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.style.minHeight = '0';
      this.root = createRoot(this);
    }
    this.root.render(<AdminEchoMissingMessagesRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('admin-echo-missing-messages')) {
  customElements.define('admin-echo-missing-messages', AdminEchoMissingMessagesElement);
}
