import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { AdminUsersNeoPage } from './routes/admin-users-neo';
import { useNeoMuiTheme } from './mui-theme';

function UsersNeoRoot() {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <AdminUsersNeoPage />
    </ThemeProvider>
  );
}

class UsersNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.root = createRoot(this);
    }
    this.root.render(<UsersNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('users-neo')) {
  customElements.define('users-neo', UsersNeoElement);
}
