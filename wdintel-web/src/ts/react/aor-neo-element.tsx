import { createRoot, Root } from 'react-dom/client';

import { AdminAorNeoPage } from './routes/admin-aor-neo';
import { NeoMuiThemeProvider } from './mui-theme';

function AorNeoRoot() {
  return (
    <NeoMuiThemeProvider>
      <AdminAorNeoPage />
    </NeoMuiThemeProvider>
  );
}

class AorNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.root = createRoot(this);
    }

    this.root.render(<AorNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('aor-neo')) {
  customElements.define('aor-neo', AorNeoElement);
}
