const LINKED_MESSAGE_PARAMS = ['m', 'mid', 'messageUid'] as const;

export function readLinkedMessageReference(searchParams: URLSearchParams): string | null {
  for (const name of LINKED_MESSAGE_PARAMS) {
    const value = searchParams.get(name)?.trim();
    if (value) return value;
  }
  return null;
}

export function readLinkedMessageReferenceFromWindow(): string | null {
  if (typeof window === 'undefined') return null;
  return readLinkedMessageReference(new URL(window.location.href).searchParams);
}

// `keepInHistory` pushes the link-free URL so browser Back returns to the linked message.
export function removeLinkedMessageReferenceFromWindowUrl({
  keepInHistory = false,
}: { keepInHistory?: boolean } = {}): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!LINKED_MESSAGE_PARAMS.some((name) => url.searchParams.has(name))) return;
  for (const name of LINKED_MESSAGE_PARAMS) url.searchParams.delete(name);
  const query = url.searchParams.toString();
  const href = `${url.pathname}${query === '' ? '' : `?${query}`}${url.hash}`;
  if (keepInHistory) window.history.pushState({}, '', href);
  else window.history.replaceState({}, '', href);
}
