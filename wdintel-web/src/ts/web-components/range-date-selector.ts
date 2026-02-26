import { daysCountText } from "../maps/utils/language-utils";

const styles = `
<style>
  .container {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin: 0 auto;
    gap: 6px;
    font-family: var(--bs-body-font-family, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif);
    color: var(--bs-body-color);
  }

  .top-row {
    background: var(--bs-card-bg, var(--bs-body-bg));
    border: 1px solid var(--bs-border-color);
    border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    box-sizing: border-box;
    padding: 7px 8px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .date-display {
    min-width: 158px;
    text-align: center;
    font-size: 15px;
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
    padding: 8px;
    color: var(--bs-body-color);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: background-color 0.2s, color 0.2s;
    font-size: 18px;
    width: 32px;
    height: 32px;
    line-height: 1;
  }

  .icon-symbol {
    display: inline-block;
    font-size: 18px;
    font-weight: 700;
    line-height: 1;
    transform: translateY(-1px);
  }

  .icon-button:hover {
    background-color: var(--bs-secondary-bg);
    color: var(--bs-primary);
  }

  .icon-button:focus {
    outline: 2px solid var(--bs-primary);
    outline-offset: 2px;
  }

  .jump-button {
    background: var(--bs-card-bg, var(--bs-body-bg));
    border: 1px solid var(--bs-border-color);
    border-radius: 6px;
    min-height: 30px;
    padding: 4px 10px;
    cursor: pointer;
    color: var(--bs-body-color);
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    transition: background-color 0.2s, color 0.2s;
  }

  .jump-button:hover {
    background-color: var(--bs-secondary-bg);
  }

  .jump-button:focus {
    outline: none;
  }
</style>


`

class DateRangeSelector extends HTMLElement {
  private currentStartDate: Date;
  private currentEndDate: Date;
  private daysJumpOption = [1, 3, 7, 30]
  private currentJumpIndex = 0;
  private selectedJumpValue = 1;
  private onJumpClick = (event: MouseEvent) => this.setRangeDays(event);
  private onMoveBackward = () => this.moveRange(-1);
  private onMoveForward = () => this.moveRange(1);

  static observedAttributes = ["dates"];

  constructor() {
    super();

    this.attachShadow({ mode: "open" })
    this.render();

  }

  connectedCallback() {
    if (this.shadowRoot) {
      this.shadowRoot.querySelector('.jump-button')?.addEventListener('click', this.onJumpClick);
      this.shadowRoot.getElementById('backward')?.addEventListener('click', this.onMoveBackward);
      this.shadowRoot.getElementById('forward')?.addEventListener('click', this.onMoveForward);
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
    }
  }

  private initializeDates(initialValue: string) {
    const { startDate, endDate } = JSON.parse(initialValue)
    this.currentStartDate = new Date(+startDate)
    this.currentEndDate = new Date(+endDate)

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
    this.currentStartDate.setDate(this.currentStartDate.getDate() + direction * this.selectedJumpValue);
    this.currentEndDate.setDate(this.currentEndDate.getDate() + direction * this.selectedJumpValue);
    this.updateDisplay();
    this.emitDateChangeEvent()
  }

  private setRangeDays(event: MouseEvent) {
    const button = event.currentTarget as HTMLButtonElement;

    this.currentJumpIndex = (this.currentJumpIndex + 1) % this.daysJumpOption.length;

    this.selectedJumpValue = this.daysJumpOption[this.currentJumpIndex];

    button.textContent = daysCountText(this.selectedJumpValue);


  }

  private updateDisplay() {
    const options: Intl.DateTimeFormatOptions = { year: '2-digit', month: '2-digit', day: '2-digit' };
    const startDisplay = this.currentStartDate.toLocaleDateString('uk', options);
    const endDisplay = this.currentEndDate.toLocaleDateString('uk', options);
    this.shadowRoot!.getElementById('dateDisplay')!.textContent = `${startDisplay} - ${endDisplay}`;
  }

  private emitDateChangeEvent() {
    const event = new CustomEvent('date-range-changed', {
      detail: {
        startDate: this.currentStartDate.getTime(), // Get start date in POSIX format
        endDate: this.currentEndDate.getTime()      // Get end date in POSIX format
      },
      bubbles: true,
      composed: true
    });
    this.dispatchEvent(event); // Dispatch the event
  }
}

// Register the custom element
customElements.define('date-range-selector', DateRangeSelector);
