import { ReleaseMeta } from '../releases-source';

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
  if (releases.length === 0) return null;

  return (
    <aside className="lg:sticky lg:top-20 self-start h-fit rounded border border-[var(--color-border)] bg-[var(--color-card)] p-3">
      <h2 className="text-sm font-semibold mb-2">Релізи</h2>
      <div className="space-y-1">
        {releases.map((release) => {
          const isSelected = selectedReleaseId === release.releaseId;
          const stateClass = isSelected
            ? ' bg-[var(--color-bg)] font-semibold'
            : ' hover:bg-[var(--color-bg)]';
          return (
            <button
              key={release.releaseId}
              type="button"
              className={`w-full text-left text-sm rounded px-2 py-1.5${stateClass}`}
              onClick={() => onSelect(release.releaseId)}
            >
              {release.title}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
