import React from "react";

export interface ProfileDropdownProps {
  user: { name: string };
  shared: { themeMode: string };
  isBasic: boolean;
  openDropdown: string | null;
  setOpenDropdown: (val: string | null) => void;
  onThemeChange: (theme: string) => void;
  onLogout: () => void;
  handleInternalLinkClick: (
    e: React.MouseEvent<HTMLAnchorElement>,
    path: string,
  ) => void;
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
  const isOpen = openDropdown === "profile";

  return (
    <div className="relative">
      <button
        className="flex appearance-none items-center gap-1 rounded border-0 px-2 py-2 text-white transition-all duration-200 hover:bg-black/10"
        onClick={(e) => {
          e.stopPropagation();
          setOpenDropdown(isOpen ? null : "profile");
        }}
        aria-haspopup="true"
        aria-expanded={isOpen ? "true" : "false"}
        type="button"
      >
        <span className="hidden sm:inline">{user?.name ?? "Unknown"}</span>
        <i
          className={`bi bi-chevron-down text-xs ml-1 transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>
      <div
        className={`absolute right-0 top-full mt-1 z-[3001] ${isOpen ? "block" : "hidden"}`}
      >
        <ul className="w-48 p-2 bg-[var(--color-card)] rounded-lg shadow-lg border border-[var(--color-border)] transition-all duration-200">
          <li>
            <a
              href="#"
              className="w-full flex items-center px-4 py-2 text-[var(--color-text)] hover:bg-black/10 dark:hover:bg-white/10 rounded transition-colors cursor-pointer border-0 text-left"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onThemeChange(shared?.themeMode === "light" ? "dark" : "light");
                closeDropdowns();
              }}
            >
              <i
                className={`bi ${shared?.themeMode === "light" ? "bi-moon" : "bi-sun"} mr-2`}
              ></i>
              {shared?.themeMode === "light" ? "Темна тема" : "Світла тема"}
            </a>
          </li>
          {isBasic && (
            <li>
              <a
                href="/settings-neo?section=my-groups"
                onClick={(e) =>
                  handleInternalLinkClick(
                    e as any,
                    "/settings-neo?section=my-groups",
                  )
                }
                className="flex items-center px-4 py-2 text-[var(--color-text)] hover:bg-black/10 dark:hover:bg-white/10 rounded transition-colors cursor-pointer"
              >
                <i className="bi bi-gear mr-2"></i>
                Налаштування
              </a>
            </li>
          )}
          <li>
            <a
              href="#"
              className="w-full flex items-center px-4 py-2 text-[var(--color-text)] hover:bg-black/10 dark:hover:bg-white/10 rounded transition-colors cursor-pointer border-0 text-left"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onLogout();
                closeDropdowns();
              }}
            >
              <i className="bi bi-box-arrow-right mr-2"></i>
              Вийти
            </a>
          </li>
        </ul>
      </div>
    </div>
  );
}
