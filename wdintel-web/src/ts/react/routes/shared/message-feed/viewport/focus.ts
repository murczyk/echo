export function getTargetCardElement(target: HTMLElement): HTMLElement {
  return (
    target.querySelector<HTMLElement>('[data-message-card-root], .message-card-root') ?? target
  );
}

export function centeredItemScrollTop(scroller: HTMLElement, target: HTMLElement): number {
  const viewport = scroller.getBoundingClientRect();
  const card = target.getBoundingClientRect();
  const scale =
    scroller.clientHeight > 0 && viewport.height > 0 ? viewport.height / scroller.clientHeight : 1;
  return (
    scroller.scrollTop + (card.top - viewport.top - (viewport.height - card.height) / 2) / scale
  );
}

export function isItemFullyVisible(scroller: HTMLElement, target: HTMLElement): boolean {
  const viewport = scroller.getBoundingClientRect();
  const card = target.getBoundingClientRect();
  return card.top >= viewport.top - 1 && card.bottom <= viewport.bottom + 1;
}
