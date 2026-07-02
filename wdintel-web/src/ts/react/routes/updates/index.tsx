import { CircularProgress } from '@mui/material';

import { ReleaseContent } from './components/ReleaseContent';
import { ReleasesSidebar } from './components/ReleasesSidebar';
import { TableOfContents } from './components/TableOfContents';
import { useUpdatesPage } from './use-updates-page';

const sidebarShellClass =
  'lg:sticky lg:top-20 self-start rounded border border-[var(--color-border)] bg-[var(--color-card)] p-3';

export function UpdatesPage() {
  const {
    releases,
    releasesLoadInProgress,
    releasesLoadError,
    selectedReleaseId,
    release,
    releaseLoadInProgress,
    releaseLoadError,
    selectRelease,
    jumpToSection,
  } = useUpdatesPage();

  return (
    <div className="box-border mx-auto max-w-[1820px] px-4 py-6">
      <h1 className="text-2xl font-semibold mb-5">Оновлення</h1>
      <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)_240px] gap-4 items-start">
        {releasesLoadError ? (
          <aside className={sidebarShellClass}>
            <div className="text-sm text-[var(--color-text-muted)]">
              Не вдалося завантажити релізи
            </div>
          </aside>
        ) : releasesLoadInProgress && releases.length === 0 ? (
          <aside className={sidebarShellClass}>
            <div className="py-3 flex justify-center">
              <CircularProgress size={20} />
            </div>
          </aside>
        ) : !releasesLoadInProgress ? (
          <ReleasesSidebar
            releases={releases}
            selectedReleaseId={selectedReleaseId}
            onSelect={selectRelease}
          />
        ) : null}

        {releaseLoadError ? (
          <div className="text-sm text-[var(--color-text-muted)]">Не вдалося завантажити реліз</div>
        ) : releaseLoadInProgress ? (
          <div className="py-8 flex justify-center">
            <CircularProgress size={28} />
          </div>
        ) : release && selectedReleaseId ? (
          <ReleaseContent releaseId={selectedReleaseId} release={release} />
        ) : (
          <div className="text-sm text-[var(--color-text-muted)]">Оберіть реліз</div>
        )}

        {release ? <TableOfContents sections={release.sections} onJump={jumpToSection} /> : null}
      </div>
    </div>
  );
}
