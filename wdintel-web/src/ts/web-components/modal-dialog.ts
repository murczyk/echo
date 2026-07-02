import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('modal-dialog')
export class ModalDialog extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false;

  protected createRenderRoot() {
    return this;
  }

  updated(changedProperties: Map<string | number | symbol, unknown>): void {
    if (changedProperties.has('open')) {
      this.setDialogState();
    }
  }

  private setDialogState(): void {
    const dialog = this.renderRoot.querySelector('dialog') as HTMLDialogElement;
    if (dialog) {
      if (this.open) {
        dialog.onclick = (event) => {
          // Closing only if clicked on scrim, not on the filler
          if (event.currentTarget === event.target) {
            this.open = false; // Update the property to close the dialog
          }
        };
        dialog.showModal();
      } else {
        dialog.close();
      }
    }
  }

  protected render() {
    return html` <slot></slot> `;
  }
}
