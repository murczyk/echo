import { createRoot, Root } from 'react-dom/client';

import { AdminDirectionsNeoPage } from './routes/admin-directions-neo';
import { NeoMuiThemeProvider } from './mui-theme';

function AdminDirectionsNeoRoot() {
  return (
    <NeoMuiThemeProvider>
      <AdminDirectionsNeoPage />
    </NeoMuiThemeProvider>
  );
}

class AdminDirectionsNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }

    this.root.render(<AdminDirectionsNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('admin-directions-neo')) {
  customElements.define('admin-directions-neo', AdminDirectionsNeoElement);
}
