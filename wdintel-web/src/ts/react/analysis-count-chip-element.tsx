import Chip from '@mui/material/Chip';
import { ThemeProvider } from '@mui/material/styles';
import React from 'react';
import { createRoot, Root } from 'react-dom/client';

import { useNeoMuiTheme } from './mui-theme';

type AnalysisCountChipProps = {
  selectedCount: number;
  overallCount: number;
  isReloading: boolean;
};

function AnalysisCountChip(props: AnalysisCountChipProps) {
  const theme = useNeoMuiTheme();
  const label = `${props.selectedCount} з ${props.overallCount}`;

  return (
    <ThemeProvider theme={theme}>
      <Chip
        size="small"
        variant="outlined"
        label={label}
        title={props.isReloading ? 'Оновлюється…' : undefined}
        aria-label={`Показано ${props.selectedCount} з ${props.overallCount}`}
        sx={{
          height: 28,
          fontSize: '0.8125rem',
          fontWeight: 600,
          bgcolor: 'background.paper',
          color: 'text.primary',
          borderColor: 'divider',
          '& .MuiChip-label': {
            px: 1.25,
          },
        }}
      />
    </ThemeProvider>
  );
}

class AnalysisCountChipElement extends HTMLElement {
  static observedAttributes = ['selected-count', 'overall-count', 'is-reloading'];
  private root: Root | null = null;
  private selectedCount = 0;
  private overallCount = 0;
  private isReloading = false;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'inline-flex';
      this.style.alignItems = 'center';
      this.root = createRoot(this);
    }
    this.readAttributes();
    this.renderComponent();
  }

  attributeChangedCallback() {
    this.readAttributes();
    this.renderComponent();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }

  private readAttributes() {
    this.selectedCount = parseCount(this.getAttribute('selected-count'));
    this.overallCount = parseCount(this.getAttribute('overall-count'));
    this.isReloading = this.getAttribute('is-reloading') === 'true';
  }

  private renderComponent() {
    if (!this.root) return;
    this.root.render(
      <AnalysisCountChip
        selectedCount={this.selectedCount}
        overallCount={this.overallCount}
        isReloading={this.isReloading}
      />,
    );
  }
}

function parseCount(raw: string | null): number {
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

if (!customElements.get('analysis-count-chip')) {
  customElements.define('analysis-count-chip', AnalysisCountChipElement);
}
