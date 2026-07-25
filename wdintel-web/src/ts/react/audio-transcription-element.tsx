import { createRoot, type Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import {
  AudioTranscriptionPreferencesProvider,
  MessageCardAudioTranscription,
} from './routes/shared/message-card/MessageCardAudioTranscription';

const AUDIO_TRANSCRIPTION_ELEMENT = 'audio-transcription-widget';

class AudioTranscriptionElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['collapsed-by-default', 'transcription'];
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.minWidth = '0';
      this.root = createRoot(this);
    }
    this.renderRoot();
  }

  attributeChangedCallback() {
    this.renderRoot();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }

  private renderRoot() {
    if (!this.root) return;

    const transcription = this.getAttribute('transcription')?.trim() ?? '';
    const collapsedByDefault = this.getAttribute('collapsed-by-default') === 'true';
    this.root.render(
      <NeoMuiThemeProvider>
        <AudioTranscriptionPreferencesProvider collapsedByDefault={collapsedByDefault}>
          <MessageCardAudioTranscription transcription={transcription} />
        </AudioTranscriptionPreferencesProvider>
      </NeoMuiThemeProvider>,
    );
  }
}

if (!customElements.get(AUDIO_TRANSCRIPTION_ELEMENT)) {
  customElements.define(AUDIO_TRANSCRIPTION_ELEMENT, AudioTranscriptionElement);
}
