import { daysCountText } from "../maps/language-utils";

const styles = `
<style>
                .container {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin: 0 auto;
  gap: 5px;
}

.top-row {
  border: 1px solid black;
  padding: 5px 10px;
  border-radius: 5px;
  font-size: 20px;
  background-color: var(--bs-tertiary-bg);
  display: flex;
  align-items: center;
  gap: 8px;
}

.bottom-row {
  
  border: 1px solid black;
  border-radius: 5px;
  padding: 2.5px 5px;
  cursor: pointer;
  background-color: var(--bs-tertiary-bg);
}
.bottom-row:hover {
  background-color: #d3d4d5;
}

.arrow {
  cursor: pointer;
  margin-top: -3px;
  user-select: none;
}

.arrow:hover {
  color: #d3d4d5;
}
            </style>


`

class DateRangeSelector extends HTMLElement {
  private currentStartDate: Date;
  private currentEndDate: Date;
  private daysJumpOption = [1, 3, 7, 30]
  private currentJumpIndex = 0;
  private selectedJumpValue = 1;

  static observedAttributes = ["dates"];

  constructor() {
    super();

    this.attachShadow({ mode: "open" })
    this.render();

  }

  connectedCallback() {
    if (this.shadowRoot) {
      this.shadowRoot.querySelector('.bottom-row')?.addEventListener('click', this.setRangeDays.bind(this));
      this.shadowRoot.getElementById('backward')?.addEventListener('click', this.moveRange.bind(this, -1));
      this.shadowRoot.getElementById('forward')?.addEventListener('click', this.moveRange.bind(this, 1));
    }
  }

  disconnectedCallback() {
    if (this.shadowRoot) {

      this.shadowRoot.querySelector('.bottom-row')?.removeEventListener('click', this.setRangeDays.bind(this));
      this.shadowRoot.getElementById('backward')?.removeEventListener('click', this.moveRange.bind(this, -1));
      this.shadowRoot.getElementById('forward')?.removeEventListener('click', this.moveRange.bind(this, 1));
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
                    <span class="arrow" id="backward">←</span>
                      <span id="dateDisplay">12.10.24 - 12.11.24</span>
                    <span class="arrow" id="forward">→</span>
                  </div>
                  <div class="bottom-row">${daysCountText(this.selectedJumpValue)}</div>
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
