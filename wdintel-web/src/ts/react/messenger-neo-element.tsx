import { createRoot, Root } from 'react-dom/client';

import { AdminMessengerNeoPage } from './routes/admin-messenger-neo';
import { NeoMuiThemeProvider } from './mui-theme';

function MessengerNeoRoot() {
  return (
    <NeoMuiThemeProvider>
      <AdminMessengerNeoPage />
    </NeoMuiThemeProvider>
  );
}

class MessengerNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.root = createRoot(this);
    }
    this.root.render(<MessengerNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('messenger-neo')) {
  customElements.define('messenger-neo', MessengerNeoElement);
}
