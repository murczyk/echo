import { createRoot, Root } from 'react-dom/client';

import { PowerSnackbarProvider } from './components/PowerSnackbar';
import { NeoMuiThemeProvider } from './mui-theme';
import { TranscriptionForwardingPage } from './routes/admin-transcription-forwarding';

function TranscriptionForwardingRoot() {
  return (
    <NeoMuiThemeProvider>
      <PowerSnackbarProvider>
        <TranscriptionForwardingPage />
      </PowerSnackbarProvider>
    </NeoMuiThemeProvider>
  );
}

class TranscriptionForwardingElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.root = createRoot(this);
    }
    this.root.render(<TranscriptionForwardingRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('transcription-forwarding')) {
  customElements.define('transcription-forwarding', TranscriptionForwardingElement);
}
