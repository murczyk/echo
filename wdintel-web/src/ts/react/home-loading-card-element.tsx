import { Box } from '@mui/material';
import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { AI_AGENT_CHAT_CARD_HEIGHT } from './routes/ai-agent-chat';
import { AnalysisLoadingSkeletons } from './routes/rer-analysis-neo/AnalysisLoadingSkeletons';

function HomeLoadingCardRoot() {
  return (
    <NeoMuiThemeProvider>
      <Box
        sx={{
          height: AI_AGENT_CHAT_CARD_HEIGHT,
          '& > .MuiPaper-root': { height: '100%', mx: 0 },
        }}
      >
        <AnalysisLoadingSkeletons rightPanelVisible={false} />
      </Box>
    </NeoMuiThemeProvider>
  );
}

class HomeLoadingCardElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.root = createRoot(this);
    }
    this.root.render(<HomeLoadingCardRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('home-loading-card')) {
  customElements.define('home-loading-card', HomeLoadingCardElement);
}
