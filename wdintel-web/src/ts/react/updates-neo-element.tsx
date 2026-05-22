import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { useNeoMuiTheme } from './mui-theme';
import { UpdatesPage } from './routes/updates';

function UpdatesNeoRoot() {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <UpdatesPage />
    </ThemeProvider>
  );
}

class UpdatesNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.root = createRoot(this);
    }

    this.root.render(<UpdatesNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('updates-neo')) {
  customElements.define('updates-neo', UpdatesNeoElement);
}
