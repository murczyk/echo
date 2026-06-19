import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { AdminAllReportsPage } from './routes/admin-all-reports';

function AdminAllReportsRoot() {
  return (
    <NeoMuiThemeProvider>
      <AdminAllReportsPage />
    </NeoMuiThemeProvider>
  );
}

class AdminAllReportsElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.root = createRoot(this);
    }
    this.root.render(<AdminAllReportsRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('admin-all-reports')) {
  customElements.define('admin-all-reports', AdminAllReportsElement);
}
