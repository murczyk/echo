import { CircularProgress } from '@mui/material';

import { ReleaseContent } from './components/ReleaseContent';
import { ReleasesSidebar } from './components/ReleasesSidebar';
import { TableOfContents } from './components/TableOfContents';
import { useUpdatesPage } from './use-updates-page';

export function UpdatesPage() {
  const {
    releases,
    selectedReleaseId,
    release,
    selectRelease,
    jumpToSection,
  } = useUpdatesPage();

  return (
    <div className="box-border mx-auto max-w-[1820px] px-4 py-6">
      <h1 className="text-2xl font-semibold mb-5">Оновлення</h1>
      <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)_240px] gap-4 items-start">
        {renderSidebar()}
        {renderMain()}
        {renderToc()}
      </div>
    </div>
  );

  function renderSidebar() {
    if (releases.kind === 'loading') {
      return (
        <aside className="lg:sticky lg:top-20 self-start rounded border border-[var(--color-border)] bg-[var(--color-card)] p-3">
          <div className="py-3 flex justify-center">
            <CircularProgress size={20} />
          </div>
        </aside>
      );
    }
    if (releases.kind === 'success') {
      return (
        <ReleasesSidebar
          releases={releases.data}
          selectedReleaseId={selectedReleaseId}
          onSelect={selectRelease}
        />
      );
    }
    if (releases.kind === 'error') {
      return (
        <aside className="lg:sticky lg:top-20 self-start rounded border border-[var(--color-border)] bg-[var(--color-card)] p-3">
          <div className="text-sm text-[var(--color-text-muted)]">
            Не вдалося завантажити релізи
          </div>
        </aside>
      );
    }
    return null;
  }

  function renderMain() {
    if (release.kind === 'loading') {
      return (
        <div className="py-8 flex justify-center">
          <CircularProgress size={28} />
        </div>
      );
    }
    if (release.kind === 'error') {
      return (
        <div className="text-sm text-[var(--color-text-muted)]">
          Не вдалося завантажити реліз
        </div>
      );
    }
    if (release.kind === 'success' && selectedReleaseId) {
      return (
        <ReleaseContent
          releaseId={selectedReleaseId}
          release={release.data}
        />
      );
    }
    return (
      <div className="text-sm text-[var(--color-text-muted)]">Оберіть реліз</div>
    );
  }

  function renderToc() {
    if (release.kind !== 'success') return null;
    return (
      <TableOfContents
        sections={release.data.sections}
        onJump={jumpToSection}
      />
    );
  }
}
