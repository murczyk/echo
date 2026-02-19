import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { AdminMessangerNeoPage } from './routes/admin-messanger-neo';
import { useNeoMuiTheme } from './mui-theme';

function MessangerNeoRoot() {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <AdminMessangerNeoPage />
    </ThemeProvider>
  );
}

class MessangerNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }

    this.root.render(<MessangerNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('messanger-neo')) {
  customElements.define('messanger-neo', MessangerNeoElement);
}
