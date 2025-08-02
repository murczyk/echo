import { computePosition, flip, shift, offset, autoUpdate } from '@floating-ui/dom';

type Placement = 'top' | 'bottom' | 'left' | 'right';

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
    return ['open', 'placement', 'overlay'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
    this.setupEventListeners();
    // Move popup to document.body to avoid table stacking context issues
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
          position: fixed;
          z-index: 9999;
          opacity: 0;
          visibility: hidden;
          transform: scale(0.95);
          transition: opacity 0.15s ease-out, transform 0.15s ease-out, visibility 0.15s ease-out;
          background: white;
          border: 1px solid #e5e5e5;
          border-radius: 8px;
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
          max-width: 400px;
          min-width: 200px;
          will-change: transform;
          backface-visibility: hidden;
          transform-style: preserve-3d;
          pointer-events: none;
        }

        .popup.open {
          opacity: 1;
          visibility: visible;
          transform: scale(1);
          pointer-events: auto;
        }

        .overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 999;
          background: rgba(0, 0, 0, 0.1);
          opacity: 0;
          visibility: hidden;
          transition: opacity 0.15s ease-out, visibility 0.15s ease-out;
        }

        .overlay.open {
          opacity: 1;
          visibility: visible;
        }

        .popup-content {
          position: relative;
          padding: 16px;
          padding-top: 48px;
        }

        .close-button {
          position: absolute;
          top: 12px;
          right: 12px;
          background: none;
          border: none;
          font-size: 16px;
          cursor: pointer;
          padding: 8px;
          line-height: 1;
          color: #6b7280;
          border-radius: 6px;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.15s ease;
          z-index: 1;
        }

        .close-button:hover {
          background: #f3f4f6;
          color: #374151;
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
    if (this.state.isTransitioning) return; // Prevent multiple transitions



    if (this.state.isOpen) {
      this.showPopup();
    } else {
      this.hidePopup();
    }
  }

  private async showPopup() {
    if (!this.anchorElement || !this.bodyPopupElement) return;
    if (this.state.isTransitioning) return; // Already transitioning


    this.state.isTransitioning = true;

    const anchorSlot = this.anchorElement.querySelector('slot[name="anchor"]') as HTMLSlotElement;
    const anchorElements = anchorSlot?.assignedElements();
    const actualAnchor = anchorElements?.[0] as HTMLElement;

    if (!actualAnchor) {
      this.state.isTransitioning = false;
      return;
    }

    const placement = (this.getAttribute('placement') || 'bottom') as Placement;
    const hasOverlay = this.hasAttribute('overlay');

    // Copy current slot content to body popup
    this.copySlotContent();

    // Show overlay if needed (in body)
    if (hasOverlay && this.bodyOverlayElement) {
      this.bodyOverlayElement.style.opacity = '1';
      this.bodyOverlayElement.style.visibility = 'visible';
    }

    // Calculate position once and set it - NO AUTO UPDATE
    const position = await computePosition(actualAnchor, this.bodyPopupElement, {
      placement,
      strategy: 'fixed',
      middleware: [
        offset(8),
        flip(),
        shift({ padding: 8 })
      ]
    });

    // Set position only once
    Object.assign(this.bodyPopupElement.style, {
      left: `${position.x}px`,
      top: `${position.y}px`
    });

    // Show popup with animation
    requestAnimationFrame(() => {
      if (this.bodyPopupElement) {
        this.bodyPopupElement.style.opacity = '1';
        this.bodyPopupElement.style.visibility = 'visible';
        this.bodyPopupElement.style.transform = 'scale(1)';
        this.bodyPopupElement.style.pointerEvents = 'auto';
      }
      // Reset transition flag after animation
      setTimeout(() => {
        this.state.isTransitioning = false;
      }, 150); // Match CSS transition duration
    });

    // Debounced reposition function to avoid too frequent updates
    let repositionTimeout: number | null = null;
    const handleReposition = async () => {
      if (!this.bodyPopupElement || !this.state.isOpen) return;
      
      // Clear previous timeout
      if (repositionTimeout) {
        clearTimeout(repositionTimeout);
      }
      
      // Debounce the reposition
      repositionTimeout = setTimeout(async () => {
        if (!this.bodyPopupElement) return;
        
        const newPosition = await computePosition(actualAnchor, this.bodyPopupElement, {
          placement,
          strategy: 'fixed',
          middleware: [
            offset(8),
            flip(),
            shift({ padding: 8 })
          ]
        });
        
        if (this.bodyPopupElement) {
          Object.assign(this.bodyPopupElement.style, {
            left: `${newPosition.x}px`,
            top: `${newPosition.y}px`
          });
        }
      }, 16); // ~60fps
    };

    // Only update on specific events
    window.addEventListener('scroll', handleReposition, { passive: true });
    window.addEventListener('resize', handleReposition, { passive: true });

    this.state.cleanup = () => {
      window.removeEventListener('scroll', handleReposition);
      window.removeEventListener('resize', handleReposition);
    };
  }

  private hidePopup() {
    if (this.state.isTransitioning) return; // Already transitioning
    

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
    
    // Reset transition flag after animation
    setTimeout(() => {
      this.state.isTransitioning = false;
    }, 150); // Match CSS transition duration
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

  private movePopupToBody() {
    if (!this.popupElement || !this.overlayElement) return;

    // Create copies in document.body (portal pattern)
    this.bodyOverlayElement = this.overlayElement.cloneNode(true) as HTMLElement;
    this.bodyPopupElement = this.popupElement.cloneNode(true) as HTMLElement;

    // Note: Content will be copied on each show to ensure it's up to date

    // Apply the same styles but outside shadow DOM
    this.bodyOverlayElement.style.cssText = `
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
    `;

    this.bodyPopupElement.style.cssText = `
      position: fixed;
      z-index: 9999;
      opacity: 0;
      visibility: hidden;
      transform: scale(0.95);
      transition: opacity 0.15s ease-out, transform 0.15s ease-out, visibility 0.15s ease-out;
      background: white;
      border: 1px solid #e5e5e5;
      border-radius: 8px;
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
      max-width: 800px;
      min-width: 400px;
      will-change: transform;
      backface-visibility: hidden;
      transform-style: preserve-3d;
      pointer-events: none;
    `;

    // Apply styles to popup content in body element
    const bodyPopupContent = this.bodyPopupElement.querySelector('.popup-content');
    if (bodyPopupContent) {
      (bodyPopupContent as HTMLElement).style.cssText = `
        position: relative;
        padding: 16px;
        padding-top: 48px;
      `;
    }

    // Apply styles to close button in body element  
    const bodyCloseButton = this.bodyPopupElement.querySelector('.close-button');
    if (bodyCloseButton) {
      (bodyCloseButton as HTMLElement).style.cssText = `
        position: absolute;
        top: 12px;
        right: 12px;
        background: none;
        border: none;
        font-size: 16px;
        cursor: pointer;
        padding: 8px;
        line-height: 1;
        color: #6b7280;
        border-radius: 6px;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s ease;
        z-index: 1;
      `;
    }

    // Add event listeners to body elements
    this.bodyOverlayElement.addEventListener('click', () => this.close());
    
    const closeButton = this.bodyPopupElement.querySelector('.close-button');
    if (closeButton) {
      closeButton.addEventListener('click', () => this.close());
      
      // Add hover effects
      closeButton.addEventListener('mouseenter', () => {
        (closeButton as HTMLElement).style.background = '#f3f4f6';
        (closeButton as HTMLElement).style.color = '#374151';
        (closeButton as HTMLElement).style.transform = 'scale(1.05)';
      });
      
      closeButton.addEventListener('mouseleave', () => {
        (closeButton as HTMLElement).style.background = 'none';
        (closeButton as HTMLElement).style.color = '#6b7280';
        (closeButton as HTMLElement).style.transform = 'scale(1)';
      });
      
      closeButton.addEventListener('mousedown', () => {
        (closeButton as HTMLElement).style.transform = 'scale(0.95)';
      });
      
      closeButton.addEventListener('mouseup', () => {
        (closeButton as HTMLElement).style.transform = 'scale(1.05)';
      });
    }

    // Append to body
    document.body.appendChild(this.bodyOverlayElement);
    document.body.appendChild(this.bodyPopupElement);

    // Hide original elements in shadow DOM
    if (this.popupElement) this.popupElement.style.display = 'none';
    if (this.overlayElement) this.overlayElement.style.display = 'none';
  }

  private copySlotContent() {
    if (!this.bodyPopupElement) return;

    // Get the original content slot
    const contentSlot = this.querySelector('[slot="content"]');
    if (contentSlot) {
      // Find the popup content container in body popup
      const popupContent = this.bodyPopupElement.querySelector('.popup-content');
      if (popupContent) {
        // Clear existing content except close button
        const closeButton = popupContent.querySelector('.close-button');
        popupContent.innerHTML = '';
        
        // Add close button back if it exists
        if (closeButton) {
          popupContent.appendChild(closeButton);
          // Re-attach event listener
          closeButton.addEventListener('click', () => this.close());
        }
        
        // Add the actual content
        const contentClone = contentSlot.cloneNode(true) as HTMLElement;
        contentClone.removeAttribute('slot'); // Remove slot attribute
        
        // Insert content before close button or at the beginning
        if (closeButton) {
          popupContent.insertBefore(contentClone, closeButton);
        } else {
          popupContent.appendChild(contentClone);
        }
      }
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