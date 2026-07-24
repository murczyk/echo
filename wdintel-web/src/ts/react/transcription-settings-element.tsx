import { createRoot, Root } from 'react-dom/client';

import { PowerSnackbarProvider } from './components/PowerSnackbar';
import { NeoMuiThemeProvider } from './mui-theme';
import { AdminTranscriptionSettingsPage } from './routes/admin-transcription-settings';

function TranscriptionSettingsRoot() {
  return (
    <NeoMuiThemeProvider>
      <PowerSnackbarProvider>
        <AdminTranscriptionSettingsPage />
      </PowerSnackbarProvider>
    </NeoMuiThemeProvider>
  );
}

class TranscriptionSettingsElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.style.minHeight = '0';
      this.root = createRoot(this);
    }
    this.root.render(<TranscriptionSettingsRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('transcription-settings')) {
  customElements.define('transcription-settings', TranscriptionSettingsElement);
}
