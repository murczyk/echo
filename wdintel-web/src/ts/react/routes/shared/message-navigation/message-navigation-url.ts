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

export function removeLinkedMessageReferenceFromWindowUrl(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  for (const name of LINKED_MESSAGE_PARAMS) url.searchParams.delete(name);
  const query = url.searchParams.toString();
  window.history.replaceState(
    {},
    '',
    `${url.pathname}${query === '' ? '' : `?${query}`}${url.hash}`,
  );
}
