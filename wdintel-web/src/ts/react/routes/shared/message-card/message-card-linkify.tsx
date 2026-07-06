import type { ReactNode } from 'react';

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/;
const TRAILING_CLOSER_RE = /[)\]}]+$/;

function countOccurrences(text: string, needle: string): number {
  if (needle === '') return 0;
  return text.split(needle).length - 1;
}

function shouldStripTrailingCloser(candidate: string, closer: ')' | ']' | '}'): boolean {
  const opener = closer === ')' ? '(' : closer === ']' ? '[' : '{';
  const prefix = candidate.slice(0, -1);
  return countOccurrences(prefix, opener) <= countOccurrences(prefix, closer);
}

function trimTrailingCharacters(candidate: string): { url: string; suffix: string } {
  let url = candidate;
  const suffixParts: string[] = [];

  while (url !== '') {
    const punctuationMatch = url.match(TRAILING_PUNCTUATION_RE);
    if (punctuationMatch != null) {
      const removed = punctuationMatch[0];
      suffixParts.unshift(removed);
      url = url.slice(0, -removed.length);
      continue;
    }

    const closerMatch = url.match(TRAILING_CLOSER_RE);
    if (closerMatch != null) {
      const closer = closerMatch[0].slice(-1) as ')' | ']' | '}';
      if (shouldStripTrailingCloser(url, closer)) {
        suffixParts.unshift(closer);
        url = url.slice(0, -1);
        continue;
      }
    }

    break;
  }

  return { url, suffix: suffixParts.join('') };
}

function toSafeUrl(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function renderLinkifiedText(text: string): ReactNode[] {
  if (text === '') return [];

  const renderedNodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_RE)) {
    const rawUrl = match[0];
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      renderedNodes.push(text.slice(lastIndex, matchIndex));
    }

    const { url, suffix } = trimTrailingCharacters(rawUrl);
    const safeUrl = toSafeUrl(url);

    if (safeUrl == null) {
      renderedNodes.push(rawUrl);
    } else {
      renderedNodes.push(
        <a
          key={`${matchIndex}:${safeUrl}`}
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: 'var(--color-action)',
            textDecoration: 'underline',
            textDecorationThickness: '1px',
            textUnderlineOffset: '2px',
          }}
        >
          {url}
        </a>,
      );
      if (suffix !== '') renderedNodes.push(suffix);
    }

    lastIndex = matchIndex + rawUrl.length;
  }

  if (lastIndex < text.length) {
    renderedNodes.push(text.slice(lastIndex));
  }

  return renderedNodes;
}
