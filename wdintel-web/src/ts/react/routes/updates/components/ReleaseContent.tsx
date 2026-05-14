import { useEffect, useRef } from 'react';

import { ParsedRelease } from '../markdown-helpers';
import { MarkdownBody } from './MarkdownBody';

interface ReleaseContentProps {
  releaseId: string;
  release: ParsedRelease;
  onActiveSectionChange: (id: string | null) => void;
}

const SCROLL_PROBE_OFFSET = 180;

export function ReleaseContent({
  releaseId,
  release,
  onActiveSectionChange,
}: ReleaseContentProps) {
  const containerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const ids = release.sections.map((s) => s.domId);
    if (ids.length === 0) return;

    const handler = () => {
      const anchor = window.scrollY + SCROLL_PROBE_OFFSET;
      let candidate: string | null = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        const top = el.getBoundingClientRect().top + window.scrollY;
        if (top <= anchor) {
          candidate = id;
        }
      }
      onActiveSectionChange(candidate);
    };

    handler();
    window.addEventListener('scroll', handler, { passive: true });
    window.addEventListener('resize', handler);
    return () => {
      window.removeEventListener('scroll', handler);
      window.removeEventListener('resize', handler);
    };
  }, [release, onActiveSectionChange]);

  return (
    <section
      ref={containerRef}
      className="rounded border border-[var(--color-border)] bg-[var(--color-card)] p-5"
    >
      <h2 className="text-2xl font-semibold">{release.title}</h2>
      <hr className="my-4 border-t border-[var(--color-border)]" />
      <ul className="space-y-4 pl-6" style={{ listStyle: 'disc' }}>
        {release.sections.map((section) => {
          const baseClass = section.heading
            ? 'scroll-mt-28 px-2 py-1 space-y-3'
            : 'px-2 py-1 space-y-3 list-none';
          return (
            <li
              key={section.domId}
              id={section.domId}
              className={`${baseClass}`}
            >
              {section.heading && (
                <h4 className="text-xl font-semibold">{section.heading}</h4>
              )}
              {section.body && (
                <MarkdownBody releaseId={releaseId} markdown={section.body} />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
