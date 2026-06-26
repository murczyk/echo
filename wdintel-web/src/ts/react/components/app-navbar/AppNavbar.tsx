import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Link,
  Menu,
  isActiveName,
  menuIsActive,
  goiExternalUrl,
  operationalSubs,
  analysisSubs,
  databaseSubs,
  converterSubs,
  adminSubs,
} from "./menu-items";
import { ChangelogDropdown } from "./ChangelogDropdown";
import { ProfileDropdown } from "./ProfileDropdown";

export interface AppNavbarProps {
  user: {
    name: string;
    roles: string[];
    goiFullAccessForOrganism: boolean;
    goiIntegrations: Array<{
      id: number;
      ownerOrganismName: string;
      goiUrl: string | null;
    }>;
  };
  shared: {
    themeMode: string;
    serverInfo: { mode: string } | null;
    changelogPreview: any;
    userLoaded: boolean;
    changelogLastSeenLoaded: boolean;
    changelogLastSeen: string | null;
  };
  activeName: string;
  isNavbarVisible: boolean;
  supportsFullscreenToggle: boolean;
  onLogout: () => void;
  onThemeChange: (theme: string) => void;
  onNavbarVisibilityChange: () => void;
  onOpenChangelog: (version: string) => void;
}

export function AppNavbar({
  user,
  shared,
  activeName,
  isNavbarVisible,
  supportsFullscreenToggle,
  onLogout,
  onThemeChange,
  onNavbarVisibilityChange,
  onOpenChangelog,
}: AppNavbarProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const navbarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (navbarRef.current && !navbarRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    };
    document.addEventListener("click", handleOutsideClick);
    return () => document.removeEventListener("click", handleOutsideClick);
  }, []);

  const handleDropdownToggle = (e: React.MouseEvent, key: string) => {
    setOpenDropdown(openDropdown === key ? null : key);
  };

  const closeDropdowns = () => {
    setOpenDropdown(null);
  };

  const handleMobileNavToggle = (e: React.MouseEvent) => {
    setMobileNavOpen(!mobileNavOpen);
  };

  const hasRole = useCallback(
    (role: string) => {
      const roles = user?.roles ?? [];
      const has = (r: string) => roles.includes(r);
      switch (role) {
        case "Admin":
          return has("Admin");
        case "Full":
          return has("Admin") || has("Full");
        case "Rer":
          return has("Admin") || has("Full") || has("Rer");
        case "Bpla":
          return has("Admin") || has("Full") || has("Bpla");
        case "Basic":
          return (
            has("Admin") ||
            has("Full") ||
            has("Bpla") ||
            has("Rer") ||
            has("Basic")
          );
        case "UnitsEditor":
          return has("Admin") || has("UnitsEditor");
        case "CallsignsEditor":
          return has("Admin") || has("CallsignsEditor");
        case "AdvancedReports":
          return has("Admin") || has("AdvancedReports");
        case "DeleteMsg":
          return has("DeleteMsg");
        case "NoAutoLogout":
          return has("NoAutoLogout");
        default:
          return false;
      }
    },
    [user],
  );

  const serverModeIsLive =
    shared?.serverInfo?.mode === "live" || shared?.serverInfo?.mode === "debug";
  const isAdminMenuVisible = hasRole("Admin");
  const isBasic = hasRole("Basic");
  const isRer = hasRole("Rer");

  const goiMenuIsVisible =
    serverModeIsLive && isRer && user.goiIntegrations?.length > 0;

  const openGoiSubs: Menu[] = (user.goiIntegrations || []).flatMap(
    (integration) => {
      if (!integration.goiUrl) return [];
      const url = goiExternalUrl(integration.goiUrl);
      if (!url) return [];
      return [
        {
          type: "item",
          link: { type: "external", link: url },
          activeName: `goi-external-${integration.id}`,
          label: `Сервер ${integration.ownerOrganismName}`,
        } as Menu,
      ];
    },
  );

  const goiSubs: Menu[] = [
    ...(user.goiFullAccessForOrganism
      ? [
          {
            type: "item",
            link: { type: "internal", path: "/goi-associations" },
            activeName: "goi-associations",
            label: "Висновки",
          } as Menu,
          {
            type: "item",
            link: { type: "internal", path: "/goi-knowledge" },
            activeName: "goi-knowledge",
            label: "Інформованість",
          } as Menu,
        ]
      : []),
    ...openGoiSubs,
    { type: "separator" },
    {
      type: "item",
      link: { type: "internal", path: "/goi-settings" },
      activeName: "goi-settings",
      label: "Налаштування",
    },
  ];

  const renderLabel = (item: { label: string; activeName: string }) => {
    return (
      <span className="inline-flex items-center gap-2">
        {item.label}
      </span>
    );
  };

  const handleInternalLinkClick = (
    e: React.MouseEvent<HTMLAnchorElement>,
    path: string,
  ) => {
    if (
      e.button === 0 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      e.preventDefault();
      window.history.pushState({}, "", path);
      window.dispatchEvent(new Event("popstate"));
      closeDropdowns();
      setMobileNavOpen(false);
    }
  };

  const renderDropdownLeaf = (
    item: { activeName: string; label: string; link: Link },
    index: number,
  ) => {
    const active = isActiveName(item.activeName, activeName);
    if (item.link.type === "internal") {
      return (
        <a
          key={index}
          className={`flex items-center justify-between px-4 py-2 text-[var(--color-text)] hover:bg-black/10 dark:hover:bg-white/10 rounded transition-all duration-200 ${active ? "font-medium" : ""}`}
          role="menuitem"
          href={item.link.path}
          onClick={(e) => handleInternalLinkClick(e, (item.link as any).path)}
        >
          {renderLabel(item)}
          {active && <i className="bi bi-check ml-2" />}
        </a>
      );
    } else {
      return (
        <a
          key={index}
          className={`flex items-center justify-between px-4 py-2 text-[var(--color-text)] hover:bg-black/10 dark:hover:bg-white/10 rounded transition-all duration-200 ${active ? "font-medium" : ""}`}
          role="menuitem"
          href={item.link.link}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => {
            closeDropdowns();
            setMobileNavOpen(false);
          }}
        >
          {renderLabel(item)}
          <i className="bi bi-box-arrow-up-right text-[var(--color-icons)] ml-2 group-hover:text-[var(--color-text)]" />
        </a>
      );
    }
  };

  const renderDropdownItem = (sub: Menu, index: number) => {
    if (sub.type === "item") {
      return <li key={index}>{renderDropdownLeaf(sub, index)}</li>;
    } else if (sub.type === "group") {
      const active = menuIsActive(activeName, sub);
      return (
        <li key={index} className="px-2 py-1">
          <div
            className={`px-2 py-1 text-xs font-semibold uppercase tracking-wide ${active ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}
          >
            {sub.label}
          </div>
          <ul className="ml-3 border-l border-[var(--color-border)] pl-2">
            {sub.subs.map((s, i) => renderDropdownItem(s, i))}
          </ul>
        </li>
      );
    } else if (sub.type === "separator") {
      return (
        <li
          key={index}
          className="mx-2 my-2 border-t border-[var(--color-border)]"
          role="separator"
        />
      );
    }
  };

  const renderDropdownMenu = (
    activeNameExp: string,
    nameText: string,
    subs: Menu[],
    mainLink?: string,
  ) => {
    const isOpen = openDropdown === activeNameExp;
    const active =
      menuIsActive(activeName, { type: "group", label: nameText, subs }) ||
      (mainLink && activeName.includes(activeNameExp));
    const dropdownMenuId = `navbar-dropdown-menu-${activeNameExp}`;

    return (
      <li className="group relative w-full lg:w-auto" key={activeNameExp}>
        {mainLink ? (
          <div
            className={`inline-flex w-full items-stretch rounded lg:w-auto overflow-hidden transition-colors ${active ? "font-medium" : ""}`}
          >
            <a
              href={mainLink}
              onClick={(e) => handleInternalLinkClick(e, mainLink)}
              className="flex items-center px-3 py-2 cursor-pointer focus:outline-none text-white hover:bg-black/10 transition-all duration-200"
            >
              <span>{nameText}</span>
            </a>
            <div className="w-[1px] bg-white/20 my-2"></div>
            <button
              className="flex items-center px-2 py-2 cursor-pointer focus:outline-none text-white hover:bg-black/10 transition-all duration-200"
              onClick={(e) => handleDropdownToggle(e, activeNameExp)}
              aria-haspopup="true"
              aria-controls={dropdownMenuId}
              aria-expanded={isOpen ? "true" : "false"}
              type="button"
            >
              <i
                className={`bi bi-chevron-down text-xs transition-transform ${isOpen ? "rotate-180" : ""}`}
              />
            </button>
          </div>
        ) : (
          <button
            className={`inline-flex w-full cursor-pointer items-center rounded px-2 py-2 text-white transition-all duration-200 hover:bg-black/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-1 lg:w-auto ${active ? "font-medium" : ""}`}
            onClick={(e) => handleDropdownToggle(e, activeNameExp)}
            aria-haspopup="true"
            aria-controls={dropdownMenuId}
            aria-expanded={isOpen ? "true" : "false"}
            type="button"
          >
            <span>{nameText}</span>
            <i
              className={`bi bi-chevron-down ml-1 text-xs transition-transform ${isOpen ? "rotate-180" : ""}`}
            />
          </button>
        )}
        <div className="app-navbar-submenu-wrap">
          <ul
            id={dropdownMenuId}
            className={`app-navbar-submenu-list min-w-0 w-full max-w-[min(100vw-2rem,16rem)] rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-2 shadow-lg transition-all duration-200 lg:w-64 lg:max-w-none ${isOpen ? "block" : "hidden"}`}
            role="menu"
          >
            {subs.map((sub, idx) => renderDropdownItem(sub, idx))}
          </ul>
        </div>
      </li>
    );
  };

  return (
    <header
      ref={navbarRef}
      className="border-b border-black/15 py-2"
      style={{
        background:
          "linear-gradient(to bottom, rgba(var(--bd-coyote-rgb), 1), rgba(var(--bd-coyote-rgb), .95))",
      }}
    >
      <nav className="w-full px-6">
        <div className="app-navbar-row flex w-full flex-wrap items-center gap-x-3 gap-y-2 lg:flex-nowrap lg:gap-x-[80px]">
          <div className="app-navbar-brand flex shrink-0 flex-row flex-nowrap items-center gap-2">
            <a
              className="app-navbar-logo flex shrink-0 items-center space-x-2"
              href="/"
              onClick={(e) => handleInternalLinkClick(e, "/")}
            >
              <div className="relative h-7 w-8">
                <div
                  className="main-image absolute"
                  style={{ height: "28px", width: "28px" }}
                >
                  <img
                    src="/img/SIGINT_190_kraken_transparent.png"
                    style={{ width: "28px", height: "28px" }}
                  />
                </div>
                <div
                  className="hover-image absolute"
                  style={{
                    width: "28px",
                    height: "28px",
                    backgroundColor: "#000",
                    borderRadius: "50%",
                  }}
                >
                  <img
                    src="/img/flying_skull_logo_transparent.png"
                    style={{ width: "28px", zIndex: 1 }}
                    alt="Flying Skull"
                  />
                </div>
              </div>
              <img
                src="/img/echo-logo.svg"
                className="h-[16px] shrink-0 invert contrast-200 brightness-0"
              />
            </a>
            <button
              className="flex appearance-none items-center justify-center rounded border-0 px-2 py-2 text-[1.625rem] leading-none text-white transition-all duration-200 hover:bg-black/10 lg:hidden"
              type="button"
              onClick={handleMobileNavToggle}
              aria-controls="app-navbar-links-panel"
              aria-expanded={mobileNavOpen ? "true" : "false"}
              aria-label={mobileNavOpen ? "Закрити меню" : "Відкрити меню"}
            >
              <i
                className={`app-navbar-mobile-menu-icon bi ${mobileNavOpen ? "bi-x-lg" : "bi-list"}`}
              ></i>
            </button>
          </div>

          <div
            id="app-navbar-links-panel"
            className={`app-navbar-links w-full min-w-0 basis-full border-t border-[var(--color-border)] lg:mt-0 lg:w-auto lg:min-w-0 lg:flex-none lg:border-t-0 lg:pt-0 ${mobileNavOpen ? "flex" : "hidden lg:flex"}`}
          >
            <ul className="app-navbar-links-list flex min-w-0 w-full flex-col gap-y-1 lg:flex-row lg:flex-wrap lg:items-center lg:gap-x-4 lg:gap-y-1">
              {serverModeIsLive &&
                isRer &&
                renderDropdownMenu(
                  "operational",
                  "Оперативний",
                  operationalSubs,
                  "/rer-duty-neo",
                )}
              {serverModeIsLive &&
                isRer &&
                renderDropdownMenu(
                  "analysis",
                  "Аналіз",
                  analysisSubs,
                  "/rer-analysis",
                )}
              {serverModeIsLive &&
                isRer &&
                renderDropdownMenu("database", "База даних", databaseSubs)}
              {goiMenuIsVisible && renderDropdownMenu("goi", "ГОІ", goiSubs)}
              {serverModeIsLive &&
                isBasic &&
                renderDropdownMenu("other", "Конвертери", converterSubs)}

              {isAdminMenuVisible &&
                renderDropdownMenu("admin", "Адмін", adminSubs)}
            </ul>
          </div>

          <div className="app-navbar-toolbar ml-auto flex shrink-0 items-center gap-2">
            <ChangelogDropdown
              shared={shared}
              openDropdown={openDropdown}
              setOpenDropdown={setOpenDropdown}
              onOpenChangelog={onOpenChangelog}
            />

            {supportsFullscreenToggle && (
              <button
                className="flex appearance-none items-center border-0 px-2 py-2 text-white transition-all duration-200 hover:bg-black/10"
                onClick={onNavbarVisibilityChange}
                title={
                  isNavbarVisible ? "Повноекранний режим" : "Звичайний режим"
                }
                aria-label={
                  isNavbarVisible ? "Повноекранний режим" : "Звичайний режим"
                }
                aria-pressed={isNavbarVisible ? "false" : "true"}
              >
                <i className="bi bi-arrows-fullscreen cursor-pointer text-white transition-colors duration-200 hover:text-white"></i>
              </button>
            )}

            <ProfileDropdown
              user={user}
              shared={shared}
              isBasic={isBasic}
              openDropdown={openDropdown}
              setOpenDropdown={setOpenDropdown}
              onThemeChange={onThemeChange}
              onLogout={onLogout}
              handleInternalLinkClick={handleInternalLinkClick}
              closeDropdowns={closeDropdowns}
            />
          </div>
        </div>
      </nav>
    </header>
  );
}
