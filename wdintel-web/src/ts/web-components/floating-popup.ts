import { computePosition, flip, shift, offset, autoUpdate } from '@floating-ui/dom';

interface FloatingPopupState {
  isOpen: boolean;
  cleanup?: () => void;
  isTransitioning: boolean;
}

class FloatingPopup extends HTMLElement {
  private state: FloatingPopupState = { isOpen: false, isTransitioning: false };
  private anchorElement: HTMLElement | null = null;
  private popupElement: HTMLElement | null = null;
  private overlayElement: HTMLElement | null = null;
  private bodyPopupElement: HTMLElement | null = null;
  private bodyOverlayElement: HTMLElement | null = null;

  static get observedAttributes() {
    return ['open', 'overlay'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
    this.setupEventListeners();
    this.movePopupToBody();
  }

  disconnectedCallback() {
    this.cleanup();
    this.removePopupFromBody();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (name === 'open') {
      const isOpen = newValue !== null;
      if (isOpen !== this.state.isOpen) {
        this.state.isOpen = isOpen;
        this.updatePopupVisibility();
      }
    }
  }

  private render() {
    if (!this.shadowRoot) return;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: contents;
        }

        .anchor {
          display: contents;
          position: static;
        }

        .popup {
          ${FloatingPopup.PORTAL_STYLES.popup}
          max-width: 400px;
          min-width: 200px;
        }

        .popup.open {
          opacity: 1;
          visibility: visible;
          transform: scale(1);
          pointer-events: auto;
        }

        .overlay {
          ${FloatingPopup.PORTAL_STYLES.overlay}
          z-index: 999;
        }

        .overlay.open {
          opacity: 1;
          visibility: visible;
        }

        .popup-content {
          ${FloatingPopup.PORTAL_STYLES.popupContent}
        }

        .close-button {
          ${FloatingPopup.PORTAL_STYLES.closeButton}
        }

        .close-button:hover {
          background: var(--color-bg-muted);
          color: var(--color-text);
          transform: scale(1.05);
        }

        .close-button:active {
          transform: scale(0.95);
        }
      </style>

      <div class="anchor">
        <slot name="anchor"></slot>
      </div>

      <div class="overlay" part="overlay"></div>
      
      <div class="popup" part="popup">
        <div class="popup-content">
          <button class="close-button" part="close-button" aria-label="Close">×</button>
          <slot name="content"></slot>
        </div>
      </div>
    `;

    this.anchorElement = this.shadowRoot.querySelector('.anchor');
    this.popupElement = this.shadowRoot.querySelector('.popup');
    this.overlayElement = this.shadowRoot.querySelector('.overlay');
  }

  private setupEventListeners() {
    if (!this.shadowRoot) return;

    // Close button
    const closeButton = this.shadowRoot.querySelector('.close-button');
    closeButton?.addEventListener('click', () => this.close());

    // Overlay click
    this.overlayElement?.addEventListener('click', () => this.close());

    // ESC key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.state.isOpen) {
        this.close();
      }
    });
  }

  private updatePopupVisibility() {
    if (!this.popupElement || !this.overlayElement) return;
    if (this.state.isTransitioning) return;

    if (this.state.isOpen) {
      this.showPopup();
    } else {
      this.hidePopup();
    }
  }

  private async showPopup() {
    if (!this.anchorElement || !this.bodyPopupElement) return;
    if (this.state.isTransitioning) return;

    this.state.isTransitioning = true;

    const anchorSlot = this.anchorElement.querySelector('slot[name="anchor"]') as HTMLSlotElement;
    const anchorElements = anchorSlot?.assignedElements();
    const actualAnchor = anchorElements?.[0] as HTMLElement;

    if (!actualAnchor) {
      this.state.isTransitioning = false;
      return;
    }

    const hasOverlay = this.hasAttribute('overlay');

    // Copy current slot content to body popup
    this.copySlotContent();

    // Show overlay if needed
    if (hasOverlay && this.bodyOverlayElement) {
      this.bodyOverlayElement.style.opacity = '1';
      this.bodyOverlayElement.style.visibility = 'visible';
    }

    // ВИДАЛЯЄМО ДУБЛЮВАННЯ КОДУ - використовуємо autoUpdate
    const updatePosition = () => {
      if (!this.bodyPopupElement || !this.state.isOpen) return;
      
      computePosition(actualAnchor, this.bodyPopupElement, {
        // Автоматичний placement на основі позиції в viewport
        placement: this.getOptimalPlacement(actualAnchor),
        strategy: 'fixed',
        middleware: [
          offset(8),
          flip(),
          shift({ padding: 8 })
        ]
      }).then(({ x, y }) => {
        if (this.bodyPopupElement) {
          Object.assign(this.bodyPopupElement.style, {
            left: `${x}px`,
            top: `${y}px`
          });
        }
      });
    };

    // Використовуємо autoUpdate замість власної логіки
    this.state.cleanup = autoUpdate(actualAnchor, this.bodyPopupElement, updatePosition);

    // Show popup with animation
    requestAnimationFrame(() => {
      if (this.bodyPopupElement) {
        this.bodyPopupElement.style.opacity = '1';
        this.bodyPopupElement.style.visibility = 'visible';
        this.bodyPopupElement.style.transform = 'scale(1)';
        this.bodyPopupElement.style.pointerEvents = 'auto';
      }
      setTimeout(() => {
        this.state.isTransitioning = false;
      }, 150);
    });
  }

  // НОВИЙ МЕТОД: Автоматичний placement на основі позиції елемента
  private getOptimalPlacement(anchor: HTMLElement): 'top' | 'bottom' | 'left' | 'right' {
    const rect = anchor.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    
    // Розраховуємо центр елемента
    const centerY = rect.top + rect.height / 2;
    const centerX = rect.left + rect.width / 2;
    
    // Визначаємо в якій частині viewport знаходиться елемент
    const isInTopHalf = centerY < viewportHeight / 2;
    const isInLeftHalf = centerX < viewportWidth / 2;
    
    // Якщо елемент в верхній половині - показуємо popup знизу
    // Якщо в нижній - зверху
    if (isInTopHalf) {
      return 'bottom';
    } else {
      return 'top';
    }
    
    // Можна розширити для left/right якщо потрібно
    // if (isInLeftHalf) return 'right';
    // else return 'left';
  }

  private hidePopup() {
    if (this.state.isTransitioning) return;

    this.state.isTransitioning = true;
    
    this.cleanup();
    
    // Hide body elements
    if (this.bodyPopupElement) {
      this.bodyPopupElement.style.opacity = '0';
      this.bodyPopupElement.style.visibility = 'hidden';
      this.bodyPopupElement.style.transform = 'scale(0.95)';
      this.bodyPopupElement.style.pointerEvents = 'none';
    }
    
    if (this.bodyOverlayElement) {
      this.bodyOverlayElement.style.opacity = '0';
      this.bodyOverlayElement.style.visibility = 'hidden';
    }
    
    setTimeout(() => {
      this.state.isTransitioning = false;
    }, 150);
  }

  private cleanup() {
    if (this.state.cleanup) {
      this.state.cleanup();
      this.state.cleanup = undefined;
    }
  }

  private close() {
    this.removeAttribute('open');
    this.dispatchEvent(new CustomEvent('popup-close', { bubbles: true }));
  }

  // СПІЛЬНІ СТИЛІ для shadow DOM та body порталів
  private static readonly PORTAL_STYLES = {
    overlay: `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 9998;
      background: rgba(0, 0, 0, 0.1);
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.15s ease-out, visibility 0.15s ease-out;
    `,
    popup: `
      position: fixed;
      z-index: 9999;
      opacity: 0;
      visibility: hidden;
      transform: scale(0.95);
      transition: opacity 0.15s ease-out, transform 0.15s ease-out, visibility 0.15s ease-out;
      background: var(--color-card);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
      max-width: 800px;
      min-width: 400px;
      will-change: transform;
      backface-visibility: hidden;
      transform-style: preserve-3d;
      pointer-events: none;
    `,
    popupContent: `
      position: relative;
      padding: 16px;
      padding-top: 48px;
      color: var(--color-text);
    `,
    closeButton: `
      position: absolute;
      top: 12px;
      right: 12px;
      background: none;
      border: none;
      font-size: 16px;
      cursor: pointer;
      padding: 8px;
      line-height: 1;
      color: var(--color-text-muted);
      border-radius: 6px;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
      z-index: 1;
    `
  };

  private movePopupToBody() {
    if (!this.popupElement || !this.overlayElement) return;

    // Create copies in document.body (portal pattern)
    this.bodyOverlayElement = this.overlayElement.cloneNode(true) as HTMLElement;
    this.bodyPopupElement = this.popupElement.cloneNode(true) as HTMLElement;

    // Apply shared styles
    this.bodyOverlayElement.style.cssText = FloatingPopup.PORTAL_STYLES.overlay;
    this.bodyPopupElement.style.cssText = FloatingPopup.PORTAL_STYLES.popup;

    // Apply styles to nested elements
    const bodyPopupContent = this.bodyPopupElement.querySelector('.popup-content');
    if (bodyPopupContent) {
      (bodyPopupContent as HTMLElement).style.cssText = FloatingPopup.PORTAL_STYLES.popupContent;
    }

    const bodyCloseButton = this.bodyPopupElement.querySelector('.close-button');
    if (bodyCloseButton) {
      (bodyCloseButton as HTMLElement).style.cssText = FloatingPopup.PORTAL_STYLES.closeButton;
    }

    // Setup event listeners for body elements
    this.setupBodyEventListeners();

    // Append to body
    document.body.appendChild(this.bodyOverlayElement);
    document.body.appendChild(this.bodyPopupElement);

    // Hide original elements in shadow DOM
    if (this.popupElement) this.popupElement.style.display = 'none';
    if (this.overlayElement) this.overlayElement.style.display = 'none';
  }

  // НОВИЙ МЕТОД: Налаштування event listeners для body елементів
  private setupBodyEventListeners() {
    if (!this.bodyOverlayElement || !this.bodyPopupElement) return;

    // Overlay click
    this.bodyOverlayElement.addEventListener('click', () => this.close());
    
    // Close button
    const closeButton = this.bodyPopupElement.querySelector('.close-button');
    if (closeButton) {
      closeButton.addEventListener('click', () => this.close());
      
      // Hover effects
      closeButton.addEventListener('mouseenter', () => {
        (closeButton as HTMLElement).style.background = 'var(--color-bg-muted)';
        (closeButton as HTMLElement).style.color = 'var(--color-text)';
        (closeButton as HTMLElement).style.transform = 'scale(1.05)';
      });
      
      closeButton.addEventListener('mouseleave', () => {
        (closeButton as HTMLElement).style.background = 'none';
        (closeButton as HTMLElement).style.color = 'var(--color-text-muted)';
        (closeButton as HTMLElement).style.transform = 'scale(1)';
      });
      
      closeButton.addEventListener('mousedown', () => {
        (closeButton as HTMLElement).style.transform = 'scale(0.95)';
      });
      
      closeButton.addEventListener('mouseup', () => {
        (closeButton as HTMLElement).style.transform = 'scale(1.05)';
      });
    }
  }

  // СПРОЩЕНИЙ МЕТОД: Копіювання контенту в body popup
  private copySlotContent() {
    if (!this.bodyPopupElement) return;

    const contentSlot = this.querySelector('[slot="content"]');
    if (!contentSlot) return;

    const popupContent = this.bodyPopupElement.querySelector('.popup-content');
    if (!popupContent) return;

    // Зберігаємо close button
    const closeButton = popupContent.querySelector('.close-button');
    
    // Очищаємо контент
    popupContent.innerHTML = '';
    
    // Додаємо close button назад
    if (closeButton) {
      popupContent.appendChild(closeButton);
    }
    
    // Клонуємо та додаємо контент
    const contentClone = contentSlot.cloneNode(true) as HTMLElement;
    contentClone.removeAttribute('slot');
    
    // Вставляємо контент перед close button
    if (closeButton) {
      popupContent.insertBefore(contentClone, closeButton);
    } else {
      popupContent.appendChild(contentClone);
    }
  }

  private removePopupFromBody() {
    if (this.bodyPopupElement) {
      document.body.removeChild(this.bodyPopupElement);
      this.bodyPopupElement = null;
    }
    if (this.bodyOverlayElement) {
      document.body.removeChild(this.bodyOverlayElement);
      this.bodyOverlayElement = null;
    }
  }

  // Public API
  open() {
    this.setAttribute('open', '');
    this.dispatchEvent(new CustomEvent('popup-open', { bubbles: true }));
  }
}

// Register the custom element
customElements.define('floating-popup', FloatingPopup);

export { FloatingPopup };