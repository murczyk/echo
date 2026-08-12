import { createRoot, Root } from 'react-dom/client';

import { PowerSnackbarProvider } from './components/PowerSnackbar';
import { NeoMuiThemeProvider } from './mui-theme';
import { AdminUserDetailsPage } from './routes/admin-user-details';

function AdminUserDetailsRoot({ loginId }: { loginId: string }) {
  return (
    <NeoMuiThemeProvider>
      <PowerSnackbarProvider>
        <AdminUserDetailsPage loginId={loginId} />
      </PowerSnackbarProvider>
    </NeoMuiThemeProvider>
  );
}

class AdminUserDetailsElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-login-id'];
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.root = createRoot(this);
    }
    this.render();
  }

  attributeChangedCallback() {
    this.render();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }

  private render() {
    if (!this.root) return;
    this.root.render(<AdminUserDetailsRoot loginId={this.getAttribute('data-login-id') ?? ''} />);
  }
}

if (!customElements.get('admin-user-details')) {
  customElements.define('admin-user-details', AdminUserDetailsElement);
}
