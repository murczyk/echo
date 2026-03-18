import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { useNeoMuiTheme } from './mui-theme';
import { AdminSystemSettingsNeoPage } from './routes/admin-system-settings-neo';

function SystemSettingsNeoRoot() {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <AdminSystemSettingsNeoPage />
    </ThemeProvider>
  );
}

class SystemSettingsNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.root = createRoot(this);
    }

    this.root.render(<SystemSettingsNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('system-settings-neo')) {
  customElements.define('system-settings-neo', SystemSettingsNeoElement);
}
