import { createRoot, type Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { UnitAttachmentUploader } from './routes/rer-unit-details/UnitAttachmentUploader';

function parseUnitId(element: Element): number | null {
  const unitId = Number(element.getAttribute('data-unit-id'));
  return Number.isInteger(unitId) && unitId > 0 ? unitId : null;
}

class UnitAttachmentUploadElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-unit-id'];
  }

  private renderRoot() {
    if (!this.root) return;
    const unitId = parseUnitId(this);
    if (unitId === null) {
      this.root.render(null);
      return;
    }
    this.root.render(
      <NeoMuiThemeProvider>
        <UnitAttachmentUploader
          key={unitId}
          unitId={unitId}
          onUploaded={(count) => {
            this.dispatchEvent(
              new CustomEvent('unit-attachments-uploaded', {
                detail: { count },
                bubbles: true,
                composed: true,
              }),
            );
          }}
        />
      </NeoMuiThemeProvider>,
    );
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.root = createRoot(this);
    }
    this.renderRoot();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (name === 'data-unit-id' && oldValue !== newValue) {
      this.renderRoot();
    }
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('unit-attachment-upload')) {
  customElements.define('unit-attachment-upload', UnitAttachmentUploadElement);
}
