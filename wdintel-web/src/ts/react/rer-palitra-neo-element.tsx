import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { useNeoMuiTheme } from './mui-theme';
import { RerPalitraNeoPage } from './routes/rer-palitra-neo';

function RerPalitraNeoRoot() {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <RerPalitraNeoPage />
    </ThemeProvider>
  );
}

class RerPalitraNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }

    this.root.render(<RerPalitraNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('rer-palitra-neo')) {
  customElements.define('rer-palitra-neo', RerPalitraNeoElement);
}
