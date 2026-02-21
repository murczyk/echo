import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { useNeoMuiTheme } from './mui-theme';
import { AdminLocationConfigsNeoPage } from './routes/admin-location-configs-neo';

function LocationConfigNeoRoot() {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <AdminLocationConfigsNeoPage />
    </ThemeProvider>
  );
}

class LocationConfigNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }

    this.root.render(<LocationConfigNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('location-config-neo')) {
  customElements.define('location-config-neo', LocationConfigNeoElement);
}
