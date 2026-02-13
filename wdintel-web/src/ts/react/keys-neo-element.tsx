import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { AdminKeysNeoPage } from './routes/admin-keys-neo';
import { useNeoMuiTheme } from './mui-theme';

function KeysNeoRoot() {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <AdminKeysNeoPage />
    </ThemeProvider>
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
