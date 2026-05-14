import { ParsedRelease } from '../markdown-helpers';
import { MarkdownBody } from './MarkdownBody';

interface ReleaseContentProps {
  releaseId: string;
  release: ParsedRelease;
}

export function ReleaseContent({
  releaseId,
  release,
}: ReleaseContentProps) {
  return (
    <section className="rounded border border-[var(--color-border)] bg-[var(--color-card)] p-5">
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
