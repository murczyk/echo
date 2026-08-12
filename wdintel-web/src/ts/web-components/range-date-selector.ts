import { daysCountText } from '../maps/utils/language-utils';

const styles = `
<style>
  .container {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin: 0 auto;
    gap: 4px;
    font-family: var(--bs-body-font-family, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif);
    color: var(--bs-body-color);
  }

  .top-row {
    background: color-mix(in srgb, var(--bs-card-bg, var(--bs-body-bg)) 86%, transparent);
    backdrop-filter: blur(6px);
    border: 1px solid color-mix(in srgb, var(--bs-body-color) 16%, transparent);
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    box-sizing: border-box;
    padding: 2px 4px;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .date-display {
    min-width: 140px;
    text-align: center;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.2;
    letter-spacing: 0.01em;
    color: var(--bs-body-color);
    user-select: none;
    white-space: nowrap;
  }

  .icon-button {
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px;
    color: var(--bs-body-color);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: background-color 0.2s, color 0.2s;
    font-size: 16px;
    width: 28px;
    height: 28px;
    line-height: 1;
  }

  .icon-symbol {
    display: inline-block;
    font-size: 16px;
    font-weight: 700;
    line-height: 1;
    transform: translateY(-1px);
  }

  .icon-button:not(:disabled):hover {
    background-color: var(--bs-secondary-bg);
    color: var(--bs-primary);
  }

  .icon-button:not(:disabled):focus {
    outline: 2px solid var(--bs-primary);
    outline-offset: 2px;
  }

  .icon-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .jump-button {
    background: var(--bs-card-bg, var(--bs-body-bg));
    border: 1px solid var(--bs-border-color);
    border-radius: 6px;
    min-height: 26px;
    padding: 2px 8px;
    cursor: pointer;
    color: var(--bs-body-color);
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    transition: background-color 0.2s, color 0.2s;
  }

  .jump-button:not(:disabled):hover {
    background-color: var(--bs-secondary-bg);
  }

  .jump-button:not(:disabled):focus {
    outline: none;
  }

  .jump-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  /* Loading state uses explicit high-contrast colors instead of generic disabled fading. */
  .jump-button.is-loading {
    opacity: 1;
    background-color: var(--bs-dark, #212529);
    color: var(--bs-light, #f8f9fa);
    border-color: var(--bs-dark, #212529);
    cursor: progress;
  }
</style>


`;

class DateRangeSelector extends HTMLElement {
  private currentStartDate: Date;
  private currentEndDate: Date;
  private daysJumpOption = [1, 3, 7, 30];
  private currentJumpIndex = 0;
  private selectedJumpValue = 1;
  private isLoading = false;
  private onJumpClick = (event: MouseEvent) => this.setRangeDays(event);
  private onMoveBackward = () => this.moveRange(-1);
  private onMoveForward = () => this.moveRange(1);

  static observedAttributes = ['dates', 'loading'];

  constructor() {
    super();

    this.attachShadow({ mode: 'open' });
    this.render();
  }

  connectedCallback() {
    if (this.shadowRoot) {
      this.shadowRoot.querySelector('.jump-button')?.addEventListener('click', this.onJumpClick);
      this.shadowRoot.getElementById('backward')?.addEventListener('click', this.onMoveBackward);
      this.shadowRoot.getElementById('forward')?.addEventListener('click', this.onMoveForward);
      this.syncControlsState();
    }
  }

  disconnectedCallback() {
    if (this.shadowRoot) {
      this.shadowRoot.querySelector('.jump-button')?.removeEventListener('click', this.onJumpClick);
      this.shadowRoot.getElementById('backward')?.removeEventListener('click', this.onMoveBackward);
      this.shadowRoot.getElementById('forward')?.removeEventListener('click', this.onMoveForward);
    }
  }

  attributeChangedCallback(name: string, oldValue: string, newValue: string) {
    if (name === 'dates') {
      this.initializeDates(newValue);
      return;
    }
    if (name === 'loading') {
      this.setLoading(newValue === 'true');
    }
  }

  private initializeDates(initialValue: string) {
    const { startDate, endDate } = JSON.parse(initialValue);
    this.currentStartDate = new Date(+startDate);
    this.currentEndDate = new Date(+endDate);

    this.updateDisplay();
  }

  private render() {
    this.shadowRoot!.innerHTML = `
                ${styles}
                <div class="container">
                  <div class="top-row">
                    <button class="icon-button" id="backward" type="button" aria-label="Попередній період">
                      <span class="icon-symbol">‹</span>
                    </button>
                    <span class="date-display" id="dateDisplay">12.10.24 - 12.11.24</span>
                    <button class="icon-button" id="forward" type="button" aria-label="Наступний період">
                      <span class="icon-symbol">›</span>
                    </button>
                  </div>
                  <button class="jump-button" type="button">${daysCountText(this.selectedJumpValue)}</button>
                </div>   
    `;
  }

  private moveRange(direction: number) {
    if (this.isLoading) {
      return;
    }
    this.currentStartDate.setDate(
      this.currentStartDate.getDate() + direction * this.selectedJumpValue,
    );
    this.currentEndDate.setDate(this.currentEndDate.getDate() + direction * this.selectedJumpValue);
    this.updateDisplay();
    this.emitDateChangeEvent();
  }

  private setRangeDays(event: MouseEvent) {
    if (this.isLoading) {
      return;
    }
    const button = event.currentTarget as HTMLButtonElement;

    this.currentJumpIndex = (this.currentJumpIndex + 1) % this.daysJumpOption.length;

    this.selectedJumpValue = this.daysJumpOption[this.currentJumpIndex];

    button.textContent = daysCountText(this.selectedJumpValue);
    this.applySelectedRangeLength();
    this.updateDisplay();
    this.emitDateChangeEvent();
  }

  private applySelectedRangeLength() {
    const nextStart = new Date(this.currentEndDate);
    // Keep current end date and adjust the range length to N days (inclusive).
    nextStart.setDate(nextStart.getDate() - this.selectedJumpValue + 1);
    this.currentStartDate = nextStart;
  }

  private updateDisplay() {
    const options: Intl.DateTimeFormatOptions = {
      year: '2-digit',
      month: '2-digit',
      day: '2-digit',
    };
    const startDisplay = this.currentStartDate.toLocaleDateString('uk', options);
    const endDisplay = this.currentEndDate.toLocaleDateString('uk', options);
    this.shadowRoot!.getElementById('dateDisplay')!.textContent = `${startDisplay} - ${endDisplay}`;
  }

  private emitDateChangeEvent() {
    this.setLoading(true);
    const event = new CustomEvent('date-range-changed', {
      detail: {
        startDate: this.currentStartDate.getTime(), // Get start date in POSIX format
        endDate: this.currentEndDate.getTime(), // Get end date in POSIX format
      },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event); // Dispatch the event
  }

  private setLoading(value: boolean) {
    if (this.isLoading === value) {
      return;
    }
    this.isLoading = value;
    this.syncControlsState();
  }

  private syncControlsState() {
    if (!this.shadowRoot) {
      return;
    }
    const backward = this.shadowRoot.getElementById('backward') as HTMLButtonElement | null;
    const forward = this.shadowRoot.getElementById('forward') as HTMLButtonElement | null;
    const jump = this.shadowRoot.querySelector('.jump-button') as HTMLButtonElement | null;

    if (backward) backward.disabled = this.isLoading;
    if (forward) forward.disabled = this.isLoading;
    if (jump) {
      jump.disabled = this.isLoading;
      jump.classList.toggle('is-loading', this.isLoading);
      jump.textContent = this.isLoading ? 'Завантаження...' : daysCountText(this.selectedJumpValue);
      jump.setAttribute('aria-busy', this.isLoading ? 'true' : 'false');
    }
  }
}

// Register the custom element
customElements.define('date-range-selector', DateRangeSelector);
