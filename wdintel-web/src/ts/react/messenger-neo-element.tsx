import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { AdminMessengerNeoPage } from './routes/admin-messenger-neo';
import { useNeoMuiTheme } from './mui-theme';

function MessengerNeoRoot() {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <AdminMessengerNeoPage />
    </ThemeProvider>
  );
}

class MessengerNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
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
