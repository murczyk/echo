import CampaignOutlinedIcon from '@mui/icons-material/CampaignOutlined';
import CloseOutlinedIcon from '@mui/icons-material/CloseOutlined';
import ConstructionOutlinedIcon from '@mui/icons-material/ConstructionOutlined';
import { IconButton, Tooltip } from '@mui/material';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { registerBrowserDebugRecorderPress } from '../../../debug-recorder';
import { NavbarToolbarIconButton } from './NavbarToolbarIconButton';

const CONSTRUCTION_EMOJIS = ['🚧', '👷', '🔨', '🔧'];

function MaintenanceNotice({ onClose }: { onClose: () => void }) {
  const [emojiIndex, setEmojiIndex] = useState(0);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setEmojiIndex((currentIndex) => (currentIndex + 1) % CONSTRUCTION_EMOJIS.length);
    }, 900);

    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <div role="status" aria-live="polite">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block min-w-5 text-center text-base leading-none motion-safe:animate-pulse"
            data-testid="construction-emoji"
            aria-hidden="true"
          >
            {CONSTRUCTION_EMOJIS[emojiIndex]}
          </span>
          Оновлення системи
        </span>
        <IconButton
          size="small"
          className="text-[var(--color-text-muted)] hover:bg-black/10 hover:text-[var(--color-text)] dark:hover:bg-white/10"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Закрити сповіщення"
          title="Закрити"
        >
          <CloseOutlinedIcon fontSize="small" />
        </IconButton>
      </div>
      <p className="m-0 text-sm text-[var(--color-text)]">відбувається оновлення системи...</p>
    </div>
  );
}

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
  const dropdownKey = 'changelog';
  const deploymentMaintenanceId = shared?.deploymentMaintenance?.id ?? null;
  const previousDeploymentMaintenanceId = useRef<string | null>(null);
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

  useEffect(() => {
    const previousId = previousDeploymentMaintenanceId.current;
    previousDeploymentMaintenanceId.current = deploymentMaintenanceId;

    if (deploymentMaintenanceId && deploymentMaintenanceId !== previousId) {
      setOpenDropdown(dropdownKey);
    } else if (!deploymentMaintenanceId && previousId && openDropdown === dropdownKey) {
      setOpenDropdown(null);
    }
  }, [deploymentMaintenanceId, openDropdown, setOpenDropdown]);

  const isOpen = openDropdown === dropdownKey;
  const hasDropdownContent = Boolean(deploymentMaintenanceId || changelogData);

  const toggleMsg = (e: MouseEvent) => {
    e.stopPropagation();
    if (registerBrowserDebugRecorderPress()) {
      setOpenDropdown(null);
      return;
    }
    if (isOpen) {
      setOpenDropdown(null);
    } else if (!deploymentMaintenanceId && changelogData?.unseen) {
      onOpenChangelog(changelogData.version);
      setOpenDropdown(dropdownKey);
    } else {
      setOpenDropdown(dropdownKey);
    }
  };

  return (
    <div className="relative">
      <Tooltip title={deploymentMaintenanceId ? 'Оновлення системи' : 'Останні зміни'}>
        <NavbarToolbarIconButton
          onClick={toggleMsg}
          aria-haspopup="true"
          aria-expanded={isOpen ? 'true' : 'false'}
          aria-label={deploymentMaintenanceId ? 'Оновлення системи' : 'Останні зміни'}
          type="button"
        >
          <span className="relative flex size-6 items-center justify-center">
            {deploymentMaintenanceId ? (
              <ConstructionOutlinedIcon
                data-testid="changelog-maintenance-icon"
                sx={{ fontSize: 24 }}
                aria-hidden="true"
              />
            ) : (
              <CampaignOutlinedIcon
                data-testid="changelog-campaign-icon"
                sx={{ fontSize: 24 }}
                aria-hidden="true"
              />
            )}
            {!deploymentMaintenanceId && changelogData?.unseen && (
              <span className="absolute -top-[1px] -right-[4px] h-2 w-2 rounded-full bg-orange-400" />
            )}
          </span>
        </NavbarToolbarIconButton>
      </Tooltip>
      {hasDropdownContent && (
        <div
          data-testid="changelog-dropdown-body"
          className={`absolute right-0 pt-2 z-[3001] ${isOpen ? 'block' : 'hidden'}`}
        >
          <div className="w-72 p-3 bg-[var(--color-card)] rounded-lg shadow-lg border border-[var(--color-border)] transition-all duration-200">
            {deploymentMaintenanceId ? (
              <MaintenanceNotice onClose={() => setOpenDropdown(null)} />
            ) : (
              <>
                <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-2">
                  Останні зміни: Реліз {changelogData!.version.replace(/-/g, '.')}
                </div>
                <ul className="space-y-1 text-sm text-[var(--color-text)] list-none max-h-64 overflow-y-auto pr-1">
                  {changelogData!.preview.map((line: string, i: number) => (
                    <li key={i} className="ml-4 list-disc leading-snug break-words">
                      {line}
                    </li>
                  ))}
                </ul>
                <div className="mt-3">
                  <a
                    href={changelogData!.fullUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-semibold text-[var(--color-text)] hover:underline"
                  >
                    Читати повністю
                  </a>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
