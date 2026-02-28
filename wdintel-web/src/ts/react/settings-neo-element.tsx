import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { SettingsNeoPage } from './routes/settings-neo';
import { useNeoMuiTheme } from './mui-theme';

function SettingsNeoRoot() {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <SettingsNeoPage />
    </ThemeProvider>
  );
}

class SettingsNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.root = createRoot(this);
    }

    this.root.render(<SettingsNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('settings-neo')) {
  customElements.define('settings-neo', SettingsNeoElement);
}
