import CheckIcon from '@mui/icons-material/Check';
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import LaptopMacOutlinedIcon from '@mui/icons-material/LaptopMacOutlined';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import type { MouseEvent } from 'react';

const MENU_ICON_SX = { fontSize: 20, width: 20, height: 20, flexShrink: 0 } as const;
const SELECTION_INDICATOR_SX = { fontSize: 16, width: 16, height: 16, flexShrink: 0 } as const;

export interface ProfileDropdownProps {
  user: { name: string };
  shared: { themeMode: string };
  isBasic: boolean;
  openDropdown: string | null;
  setOpenDropdown: (val: string | null) => void;
  onThemeChange: (theme: string) => void;
  onLogout: () => void;
  handleInternalLinkClick: (e: MouseEvent<HTMLAnchorElement>, path: string) => void;
  closeDropdowns: () => void;
}

export function ProfileDropdown({
  user,
  shared,
  isBasic,
  openDropdown,
  setOpenDropdown,
  onThemeChange,
  onLogout,
  handleInternalLinkClick,
  closeDropdowns,
}: ProfileDropdownProps) {
  const isOpen = openDropdown === 'profile';

  return (
    <div className="relative">
      <button
        className="flex appearance-none items-center gap-1 rounded border-0 px-2 py-2 text-white transition-all duration-200 hover:bg-black/10"
        onClick={(e) => {
          e.stopPropagation();
          setOpenDropdown(isOpen ? null : 'profile');
        }}
        aria-haspopup="true"
        aria-expanded={isOpen ? 'true' : 'false'}
        type="button"
      >
        <span className="hidden sm:inline">{user?.name ?? 'Unknown'}</span>
        <ExpandMoreIcon
          className={`ml-[8px] transition-transform ${isOpen ? 'rotate-180' : ''}`}
          sx={SELECTION_INDICATOR_SX}
          aria-hidden="true"
        />
      </button>
      <div className={`absolute right-0 top-full mt-1 z-[3001] ${isOpen ? 'block' : 'hidden'}`}>
        <ul className="w-max min-w-56 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] !p-[8px] shadow-lg transition-all duration-200">
          <li>
            <a
              href="#"
              className="flex min-h-[40px] w-full items-center rounded border-0 p-[8px] text-left text-[var(--color-text)] transition-colors hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer whitespace-nowrap"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onThemeChange('light');
                closeDropdowns();
              }}
            >
              <LightModeOutlinedIcon className="mr-[8px]" sx={MENU_ICON_SX} aria-hidden="true" />
              Світла тема
              <span className="ml-auto flex h-[16px] w-[16px] shrink-0 items-center justify-center">
                {shared?.themeMode === 'light' && (
                  <CheckIcon
                    className="text-[var(--color-primary)]"
                    sx={SELECTION_INDICATOR_SX}
                    aria-hidden="true"
                  />
                )}
              </span>
            </a>
          </li>
          <li>
            <a
              href="#"
              className="flex min-h-[40px] w-full items-center rounded border-0 p-[8px] text-left text-[var(--color-text)] transition-colors hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer whitespace-nowrap"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onThemeChange('dark');
                closeDropdowns();
              }}
            >
              <DarkModeOutlinedIcon className="mr-[8px]" sx={MENU_ICON_SX} aria-hidden="true" />
              Темна тема
              <span className="ml-auto flex h-[16px] w-[16px] shrink-0 items-center justify-center">
                {shared?.themeMode === 'dark' && (
                  <CheckIcon
                    className="text-[var(--color-primary)]"
                    sx={SELECTION_INDICATOR_SX}
                    aria-hidden="true"
                  />
                )}
              </span>
            </a>
          </li>
          <li>
            <a
              href="#"
              className="flex min-h-[40px] w-full items-center rounded border-0 p-[8px] text-left text-[var(--color-text)] transition-colors hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer whitespace-nowrap"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onThemeChange('system');
                closeDropdowns();
              }}
            >
              <LaptopMacOutlinedIcon className="mr-[8px]" sx={MENU_ICON_SX} aria-hidden="true" />
              Авто (система)
              <span className="ml-auto flex h-[16px] w-[16px] shrink-0 items-center justify-center">
                {shared?.themeMode === 'system' && (
                  <CheckIcon
                    className="text-[var(--color-primary)]"
                    sx={SELECTION_INDICATOR_SX}
                    aria-hidden="true"
                  />
                )}
              </span>
            </a>
          </li>
          <li className="my-[8px] border-t border-[var(--color-border)]"></li>
          {isBasic && (
            <>
              <li>
                <a
                  href="/my-reports"
                  onClick={(e) => handleInternalLinkClick(e as any, '/my-reports')}
                  className="flex min-h-[40px] items-center rounded p-[8px] text-[var(--color-text)] transition-colors hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer whitespace-nowrap"
                >
                  <DescriptionOutlinedIcon
                    className="mr-[8px]"
                    sx={MENU_ICON_SX}
                    aria-hidden="true"
                  />
                  Мої звіти
                </a>
              </li>
              <li>
                <a
                  href="/settings-neo?section=my-groups"
                  onClick={(e) =>
                    handleInternalLinkClick(e as any, '/settings-neo?section=my-groups')
                  }
                  className="flex min-h-[40px] items-center rounded p-[8px] text-[var(--color-text)] transition-colors hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer whitespace-nowrap"
                >
                  <SettingsOutlinedIcon className="mr-[8px]" sx={MENU_ICON_SX} aria-hidden="true" />
                  Налаштування
                </a>
              </li>
            </>
          )}
          <li>
            <a
              href="#"
              className="flex min-h-[40px] w-full items-center rounded border-0 p-[8px] text-left text-[var(--color-text)] transition-colors hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer whitespace-nowrap"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onLogout();
                closeDropdowns();
              }}
            >
              <LogoutOutlinedIcon className="mr-[8px]" sx={MENU_ICON_SX} aria-hidden="true" />
              Вийти
            </a>
          </li>
        </ul>
      </div>
    </div>
  );
}
