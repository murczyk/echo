import { createRoot, Root } from 'react-dom/client';

import { AdminNeoPage } from './routes/admin-neo';
import { NeoMuiThemeProvider } from './mui-theme';

function AdminNeoRoot() {
  return (
    <NeoMuiThemeProvider>
      <AdminNeoPage />
    </NeoMuiThemeProvider>
  );
}

class AdminNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }

    this.root.render(<AdminNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('admin-neo')) {
  customElements.define('admin-neo', AdminNeoElement);
}
