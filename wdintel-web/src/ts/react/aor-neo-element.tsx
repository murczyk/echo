import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { AdminAorNeoPage } from './routes/admin-aor-neo';
import { useNeoMuiTheme } from './mui-theme';

function AorNeoRoot() {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <AdminAorNeoPage />
    </ThemeProvider>
  );
}

class AorNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
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
