import { useEffect, useRef, useState } from 'react';

import { ReleaseMeta } from '../releases.service';

interface ReleasesSidebarProps {
  releases: ReleaseMeta[];
  selectedReleaseId: string | null;
  onSelect: (releaseId: string) => void;
}

export function ReleasesSidebar({
  releases,
  selectedReleaseId,
  onSelect,
}: ReleasesSidebarProps) {
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const releaseRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    if (!selectedReleaseId) return;
    const activeReleaseElement = releaseRefs.current[selectedReleaseId];
    const listElement = listRef.current;
    if (!activeReleaseElement || !listElement) return;

    const elementTop = activeReleaseElement.offsetTop;
    const elementBottom = elementTop + activeReleaseElement.offsetHeight;
    const viewportTop = listElement.scrollTop;
    const viewportBottom = viewportTop + listElement.clientHeight;

    if (elementTop < viewportTop || elementBottom > viewportBottom) {
      activeReleaseElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedReleaseId]);

  if (releases.length === 0) return null;

  return (
    <aside className="lg:sticky lg:top-20 self-start h-fit rounded border border-[var(--color-border)] bg-[var(--color-card)] p-3">

      <button
        type="button"
        className="mb-2 flex w-full items-center justify-between text-left text-sm font-semibold lg:hidden"
        onClick={() => setIsMobileOpen((prev) => !prev)}
        aria-expanded={isMobileOpen}
        aria-label="Перемкнути список релізів"
      >
        <span>Релізи</span>
        <i
          className={`bi text-xs transition-transform ${isMobileOpen ? 'bi-chevron-up' : 'bi-chevron-down'}`}
        />
      </button>
      <h2 className="mb-2 hidden text-sm font-semibold lg:block">Релізи</h2>
      <div
        ref={listRef}
        className={`${isMobileOpen ? 'block' : 'hidden'} space-y-1 overflow-y-auto pr-1 max-h-[calc(100vh-9rem)] lg:block`}
      >
        {releases.map((release) => {
          const isSelected = selectedReleaseId === release.releaseId;
          return (
            <button
              key={release.releaseId}
              type="button"
              ref={(element) => {
                releaseRefs.current[release.releaseId] = element;
              }}
              className="group relative w-full text-left text-sm rounded py-1.5 pl-0 pr-0"
              onClick={() => onSelect(release.releaseId)}
            >
              <span
                className={`pointer-events-none absolute bottom-1 -left-2 top-1 w-[2px] rounded-r bg-gradient-to-b from-[#005fb8] to-[#6fb5ff] transition-opacity ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
              />
              <span
                className={`block pl-0 pr-0 transition-colors ${isSelected ? 'font-semibold text-[#005fb8]' : 'text-[var(--color-text)] group-hover:underline'}`}
              >
                {release.title}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
