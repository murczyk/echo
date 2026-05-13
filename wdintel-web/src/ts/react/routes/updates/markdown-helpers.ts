export interface ReleaseSection {
  /** DOM id for the section anchor. */
  domId: string;
  /** Heading text shown in the TOC. May be null for content above the first H2. */
  heading: string | null;
  /** Raw markdown body of the section (without the heading line). */
  body: string;
}

export interface ParsedRelease {
  /** H1 title of the release. Falls back to release id when missing. */
  title: string;
  sections: ReleaseSection[];
}

const FALLBACK_SECTION_ID = 'release-section-top';

function splitLinesPreservingFences(markdown: string): Array<{ line: string; inFence: boolean }> {
  const lines = markdown.split('\n');
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return { line, inFence: true };
    }
    return { line, inFence };
  });
}

export function parseRelease(markdown: string, fallbackTitle: string): ParsedRelease {
  const tagged = splitLinesPreservingFences(markdown);

  let title: string | null = null;
  const sections: ReleaseSection[] = [];
  let currentHeading: string | null = null;
  let currentBody: string[] = [];
  let sectionIndex = 0;

  const pushCurrent = () => {
    const bodyText = currentBody.join('\n').replace(/^\n+|\n+$/g, '');
    if (currentHeading !== null || bodyText.length > 0) {
      sections.push({
        domId: `release-section-${sectionIndex}`,
        heading: currentHeading,
        body: bodyText,
      });
      sectionIndex++;
    }
  };

  for (const { line, inFence } of tagged) {
    if (!inFence) {
      const h1Match = /^#\s+(.+?)\s*$/.exec(line);
      if (h1Match && title === null) {
        title = h1Match[1].trim();
        continue;
      }
      const h2Match = /^##\s+(.+?)\s*$/.exec(line);
      if (h2Match) {
        pushCurrent();
        currentHeading = h2Match[1].trim();
        currentBody = [];
        continue;
      }
    }
    currentBody.push(line);
  }
  pushCurrent();

  if (sections.length === 0) {
    sections.push({ domId: FALLBACK_SECTION_ID, heading: null, body: '' });
  }

  return {
    title: title ?? fallbackTitle,
    sections,
  };
}

const MEDIA_PATTERNS: Array<{
  regex: RegExp;
  group: number;
  rebuild: (match: string, resolved: string) => string;
}> = [
  {
    regex: /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g,
    group: 2,
    rebuild: (match, resolved) =>
      match.replace(/\(([^)\s]+)(\s+"[^"]*")?\)/, `(${resolved}$2)`),
  },
  {
    regex: /(\b(?:src|href|poster)\s*=\s*")([^"]+)(")/g,
    group: 2,
    rebuild: (match, resolved) => match.replace(/="[^"]+"/, `="${resolved}"`),
  },
  // Zola shortcodes used in release.md files
  {
    regex: /\{\{video\(id="([^"]+)"\)\}\}/g,
    group: 1,
    rebuild: (_match, resolved) =>
      `<video src="${resolved}" controls preload="metadata"></video>`,
  },
  {
    regex: /\{\{image\(id="([^"]+)"\)\}\}/g,
    group: 1,
    rebuild: (_match, resolved) => `<img src="${resolved}" />`,
  },
];

export function rewriteRelativeMediaUrls(
  markdown: string,
  resolve: (href: string) => string,
): string {
  let output = markdown;
  for (const pattern of MEDIA_PATTERNS) {
    output = output.replace(pattern.regex, (match, ...groups) => {
      const original = groups[pattern.group - 1] as string;
      const resolved = resolve(original);
      if (resolved === original) return match;
      return pattern.rebuild(match, resolved);
    });
  }
  return output;
}
