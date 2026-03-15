import { createRoot, Root } from 'react-dom/client';

import { AdminKeysNeoPage } from './routes/admin-keys-neo';
import { NeoMuiThemeProvider } from './mui-theme';

function KeysNeoRoot() {
  return (
    <NeoMuiThemeProvider>
      <AdminKeysNeoPage />
    </NeoMuiThemeProvider>
  );
}

class KeysNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }

    this.root.render(<KeysNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('keys-neo')) {
  customElements.define('keys-neo', KeysNeoElement);
}
