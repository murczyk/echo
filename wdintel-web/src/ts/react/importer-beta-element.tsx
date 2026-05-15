import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { useNeoMuiTheme } from './mui-theme';
import { ImporterBetaPage } from './routes/importer-beta';

function ImporterBetaRoot() {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <ImporterBetaPage />
    </ThemeProvider>
  );
}

class ImporterBetaElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.root = createRoot(this);
    }

    this.root.render(<ImporterBetaRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('importer-beta')) {
  customElements.define('importer-beta', ImporterBetaElement);
}
