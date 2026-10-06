type LogoCoinSide = 'front' | 'back';

const AUTO_INTERVAL_PROPERTY = '--logo-coin-auto-interval';
const DEFAULT_AUTO_INTERVAL_MS = 3000;

const controllers = new WeakMap<HTMLElement, LogoCoinController>();

function oppositeSide(side: LogoCoinSide): LogoCoinSide {
  return side === 'front' ? 'back' : 'front';
}

function readCssTimeMs(element: HTMLElement, property: string, fallback: number): number {
  const value = getComputedStyle(element).getPropertyValue(property).trim();
  if (value.endsWith('ms')) return Number.parseFloat(value);
  if (value.endsWith('s')) return Number.parseFloat(value) * 1000;
  return fallback;
}

function isInViewport(element: HTMLElement): boolean {
  const box = element.getBoundingClientRect();
  return box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
}

class LogoCoinController {
  private currentSide: LogoCoinSide = 'front';
  private requestedSide: LogoCoinSide = 'front';
  private isAnimating = false;
  private isFocused = false;
  private isHovered = false;
  private animationRun = 0;
  private autoTimer: number | undefined;

  constructor(private readonly coin: HTMLElement) {
    this.coin.dataset.logoCoinSide = this.currentSide;

    if (this.coin.classList.contains('logo-coin--auto')) {
      const interval = readCssTimeMs(this.coin, AUTO_INTERVAL_PROPERTY, DEFAULT_AUTO_INTERVAL_MS);
      this.autoTimer = window.setInterval(() => this.requestAutomaticFlip(), interval);
    }
  }

  dispose() {
    if (this.autoTimer !== undefined) window.clearInterval(this.autoTimer);
  }

  setHovered(isHovered: boolean) {
    this.isHovered = isHovered;
    this.requestSide(this.isHovered || this.isFocused ? 'back' : 'front');
  }

  setFocused(isFocused: boolean) {
    this.isFocused = isFocused;
    this.requestSide(this.isHovered || this.isFocused ? 'back' : 'front');
  }

  private requestAutomaticFlip() {
    if (
      this.isHovered ||
      this.isFocused ||
      document.visibilityState === 'hidden' ||
      !isInViewport(this.coin)
    ) {
      return;
    }

    this.requestSide(oppositeSide(this.requestedSide));
  }

  private requestSide(side: LogoCoinSide) {
    this.requestedSide = side;
    if (this.isAnimating || side === this.currentSide) return;

    this.isAnimating = true;
    const animationRun = ++this.animationRun;
    this.coin.dataset.logoCoinSide = side;

    requestAnimationFrame(() => {
      const animations = this.coin.getAnimations({ subtree: true });
      if (animations.length === 0) {
        this.finishFlip(side, animationRun);
        return;
      }

      void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        this.finishFlip(side, animationRun);
      });
    });
  }

  private finishFlip(side: LogoCoinSide, animationRun: number) {
    if (animationRun !== this.animationRun) return;

    this.currentSide = side;
    this.isAnimating = false;
    if (this.requestedSide !== this.currentSide) this.requestSide(this.requestedSide);
  }
}

function registerCoin(coin: HTMLElement): LogoCoinController | undefined {
  const registered = controllers.get(coin);
  if (registered) return registered;

  const disc = coin.querySelector<HTMLElement>('.logo-coin__disc');
  if (!disc) return undefined;

  const controller = new LogoCoinController(coin);
  controllers.set(coin, controller);
  return controller;
}

function controllerFromTrigger(trigger: HTMLElement): LogoCoinController | undefined {
  const coin = trigger.querySelector<HTMLElement>('.logo-coin');
  return coin ? registerCoin(coin) : undefined;
}

function triggerAtBoundary(event: MouseEvent | FocusEvent): HTMLElement | undefined {
  if (!(event.target instanceof Element)) return undefined;

  const trigger = event.target.closest<HTMLElement>('.logo-coin-trigger');
  if (!trigger) return undefined;
  if (event.relatedTarget instanceof Node && trigger.contains(event.relatedTarget))
    return undefined;
  return trigger;
}

function registerTree(node: Node) {
  if (!(node instanceof Element)) return;
  if (node.matches('.logo-coin')) registerCoin(node as HTMLElement);
  node.querySelectorAll<HTMLElement>('.logo-coin').forEach(registerCoin);
}

function disposeTree(node: Node) {
  if (!(node instanceof Element)) return;

  const coins = node.matches('.logo-coin')
    ? [node as HTMLElement]
    : Array.from(node.querySelectorAll<HTMLElement>('.logo-coin'));
  coins.forEach((coin) => {
    controllers.get(coin)?.dispose();
    controllers.delete(coin);
  });
}

function initializeLogoCoins() {
  document.querySelectorAll<HTMLElement>('.logo-coin').forEach(registerCoin);

  document.addEventListener('mouseover', (event) => {
    const trigger = triggerAtBoundary(event);
    if (trigger) controllerFromTrigger(trigger)?.setHovered(true);
  });
  document.addEventListener('mouseout', (event) => {
    const trigger = triggerAtBoundary(event);
    if (trigger) controllerFromTrigger(trigger)?.setHovered(false);
  });
  document.addEventListener('focusin', (event) => {
    const trigger = triggerAtBoundary(event);
    if (trigger) controllerFromTrigger(trigger)?.setFocused(true);
  });
  document.addEventListener('focusout', (event) => {
    const trigger = triggerAtBoundary(event);
    if (trigger) controllerFromTrigger(trigger)?.setFocused(false);
  });

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.removedNodes.forEach(disposeTree);
      mutation.addedNodes.forEach(registerTree);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

initializeLogoCoins();
