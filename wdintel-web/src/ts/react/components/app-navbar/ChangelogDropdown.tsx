import React from 'react';

export interface ChangelogDropdownProps {
  shared: any;
  openDropdown: string | null;
  setOpenDropdown: (val: string | null) => void;
  onOpenChangelog: (version: string) => void;
}

export function ChangelogDropdown({
  shared,
  openDropdown,
  setOpenDropdown,
  onOpenChangelog,
}: ChangelogDropdownProps) {
  let changelogData: {
    preview: string[];
    version: string;
    fullUrl: string;
    unseen: boolean;
  } | null = null;
  if (shared?.changelogPreview && shared.changelogPreview.preview?.length > 0) {
    const preview = shared.changelogPreview;
    let unseen = false;
    if (shared.userLoaded && shared.changelogLastSeenLoaded) {
      if (shared.changelogLastSeen === null) {
        unseen = true;
      } else {
        unseen = shared.changelogLastSeen !== preview.version;
      }
    }
    changelogData = {
      preview: preview.preview,
      version: preview.version,
      fullUrl: preview.fullUrl,
      unseen,
    };
  }

  if (!changelogData) return null;
  const dropdownKey = 'changelog';
  const isOpen = openDropdown === dropdownKey;

  const toggleMsg = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isOpen) {
      setOpenDropdown(null);
    } else if (changelogData?.unseen) {
      onOpenChangelog(changelogData!.version);
      setOpenDropdown(dropdownKey);
    } else {
      setOpenDropdown(dropdownKey);
    }
  };

  return (
    <div className="relative">
      <button
        className="block py-2 text-white hover:bg-black/10 px-2 rounded transition-all duration-200 border-0 appearance-none flex items-center"
        onClick={toggleMsg}
        aria-haspopup="true"
        aria-expanded={isOpen ? 'true' : 'false'}
        aria-label="Останні зміни"
        title="Останні зміни"
        type="button"
      >
        <div className="relative">
          <i className="bi bi-megaphone text-lg leading-none" aria-hidden="true" />
          {changelogData.unseen && (
            <span className="absolute -top-[1px] -right-[4px] h-2 w-2 rounded-full bg-orange-400" />
          )}
        </div>
      </button>
      <div className={`absolute right-0 pt-2 z-[3001] ${isOpen ? 'block' : 'hidden'}`}>
        <ul className="w-72 p-3 bg-[var(--color-card)] rounded-lg shadow-lg border border-[var(--color-border)] transition-all duration-200">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-2">
            Останні зміни: Реліз {changelogData.version.replace(/-/g, '.')}
          </div>
          <ul className="space-y-1 text-sm text-[var(--color-text)] list-none max-h-64 overflow-y-auto pr-1">
            {changelogData.preview.map((line: string, i: number) => (
              <li key={i} className="ml-4 list-disc leading-snug break-words">
                {line}
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <a
              href={changelogData.fullUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold text-[var(--color-text)] hover:underline"
            >
              Читати повністю
            </a>
          </div>
        </ul>
      </div>
    </div>
  );
}
