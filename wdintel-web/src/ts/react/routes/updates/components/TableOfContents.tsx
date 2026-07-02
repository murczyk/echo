import { ReleaseSection } from '../markdown-helpers';

interface TableOfContentsProps {
  sections: ReleaseSection[];
  onJump: (id: string) => void;
}

export function TableOfContents({ sections, onJump }: TableOfContentsProps) {
  const headed = sections.filter((s) => s.heading !== null);
  if (headed.length === 0) return null;

  return (
    <aside className="hidden lg:sticky lg:top-20 lg:block self-start h-fit rounded border border-[var(--color-border)] bg-[var(--color-card)] p-3">
      <h2 className="text-sm font-semibold mb-2">Зміст</h2>
      <ul className="space-y-1 max-h-[calc(100vh-9rem)] overflow-y-auto pr-1">
        {headed.map((section) => (
          <li key={section.domId} className="w-full text-left text-xs leading-snug rounded">
            <button
              type="button"
              className="w-full text-left text-xs leading-snug rounded py-1.5 pl-0 pr-0 hover:bg-[var(--color-bg)] hover:underline"
              onClick={() => onJump(section.domId)}
            >
              {section.heading}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
