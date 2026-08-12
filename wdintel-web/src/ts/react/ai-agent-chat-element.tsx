import { createRoot, Root } from 'react-dom/client';

import { PowerSnackbarProvider } from './components/PowerSnackbar';
import { NeoMuiThemeProvider } from './mui-theme';
import { AiAgentChat } from './routes/ai-agent-chat';

function AiAgentChatRoot({
  onAvailabilityChange,
}: {
  onAvailabilityChange: (enabled: boolean) => void;
}) {
  return (
    <NeoMuiThemeProvider>
      <PowerSnackbarProvider>
        <AiAgentChat onAvailabilityChange={onAvailabilityChange} />
      </PowerSnackbarProvider>
    </NeoMuiThemeProvider>
  );
}

class AiAgentChatElement extends HTMLElement {
  private root: Root | null = null;

  private readonly handleAvailabilityChange = (enabled: boolean) => {
    this.dispatchEvent(
      new CustomEvent('ai-agent-availability', {
        bubbles: true,
        detail: { enabled },
      }),
    );
  };

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.root = createRoot(this);
    }
    this.root.render(<AiAgentChatRoot onAvailabilityChange={this.handleAvailabilityChange} />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('ai-agent-chat')) {
  customElements.define('ai-agent-chat', AiAgentChatElement);
}
