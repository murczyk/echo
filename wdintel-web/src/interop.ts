
import '@shoelace-style/shoelace/dist/themes/light.css';

import '@shoelace-style/shoelace/dist/components/popup/popup.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/radio-button/radio-button.js';
import '@shoelace-style/shoelace/dist/components/radio-group/radio-group.js';
import "bootstrap/dist/js/bootstrap.bundle.min.js"
import "bootstrap/dist/css/bootstrap.css"
import { inverse, forward } from "mgrs"
import { td_usk2000_to_wgs84, td_wgs84_to_usk2000 } from "./ts/utils"
import "./ts/web-components/bar-chart"
import "./ts/web-components/freq-activity-chart"
import "./ts/web-components/freq-detail-chart"
import "./styles/style.css"
import "./styles/floating-popup.css"
import { setupMap, addPointsToLayer } from './ts/maps/maps'
import { MapPoint, MapPointDetailed, MapPointShort } from './ts/maps/types'
import './ts/web-components/analysis-map'
import './ts/react/analysis-map-search-element'
import './ts/react/analysis-map-palitras-element'
import './ts/react/analysis-count-chip-element'
import './ts/web-components/modal-dialog.ts'
import './ts/web-components/bar-chart-2.ts'
import './ts/web-components/small-map.ts'
import './ts/web-components/floating-popup.ts'
import './ts/react/aor-neo-element'
import './ts/react/admin-directions-neo-element'
import './ts/react/aor-neo-form-element'
import './ts/react/control-panel-neo-element'
import './ts/react/keys-neo-element'
import './ts/react/location-config-neo-element'
import './ts/react/messenger-neo-element'
import './ts/react/organisms-neo-element'
import './ts/react/organisms-neo-edit-element'
import './ts/react/settings-neo-element'
import './ts/react/tags-neo-element'
import './ts/react/tags-neo-edit-element'
import './ts/react/tags-neo-keyword-edit-element'
import './ts/react/users-neo-element'
import './ts/react/rer-duty-neo-element'
import './ts/react/rer-palitra-neo-element'
import './ts/react/rer-callsigns-neo-element'
import { saveRerAnalysisQueryState } from "./ts/rer-analysis-query-state"
import { setupCommentDraftTracker } from "./ts/comment-draft-tracker"

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';


dayjs.extend(utc);
dayjs.extend(timezone);

const RER_CALLSIGNS_NEO_BETA_BANNER_DISMISSED_KEY = 'rer-callsigns-neo-beta-banner-dismissed';

// Theme management functions
type AppliedTheme = 'light' | 'dark';

let themeSwitchOverlay: HTMLDivElement | null = null;
let themeSwitchStyleMounted = false;
let themeApplyRequestToken = 0;

function ensureThemeSwitchUi(): HTMLDivElement {
    if (!themeSwitchStyleMounted) {
        const style = document.createElement('style');
        style.id = 'theme-switch-overlay-style';
        style.textContent = `
html.theme-switching *, html.theme-switching *::before, html.theme-switching *::after {
  transition: none !important;
}

#theme-switch-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.2);
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease-in-out;
}

#theme-switch-overlay.visible {
  opacity: 1;
}

#theme-switch-overlay .theme-switch-overlay__card {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(16, 18, 21, 0.92);
  color: #fff;
  font-size: 14px;
  line-height: 1;
  font-weight: 500;
}

#theme-switch-overlay .theme-switch-overlay__spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: theme-switch-spin 0.75s linear infinite;
}

@keyframes theme-switch-spin {
  to { transform: rotate(360deg); }
}`;
        document.head.appendChild(style);
        themeSwitchStyleMounted = true;
    }

    if (!themeSwitchOverlay) {
        const overlay = document.createElement('div');
        overlay.id = 'theme-switch-overlay';
        overlay.innerHTML = `
<div class="theme-switch-overlay__card">
  <span class="theme-switch-overlay__spinner" aria-hidden="true"></span>
  <span>Зміна теми...</span>
</div>`;
        document.body.appendChild(overlay);
        themeSwitchOverlay = overlay;
    }

    return themeSwitchOverlay;
}

function resetThemeSwitchUi() {
    if (themeSwitchOverlay) {
        themeSwitchOverlay.classList.remove('visible');
    }
    document.documentElement.classList.remove('theme-switching');
}

function getResolvedTheme(themeMode: string): AppliedTheme {
    if (themeMode === 'dark') return 'dark';
    if (themeMode === 'light') return 'light';
    if (themeMode === 'system') {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
}

function getCurrentAppliedTheme(): AppliedTheme {
    return document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'dark' : 'light';
}

function applyResolvedTheme(theme: AppliedTheme) {
    const htmlElement = document.documentElement;
    if (theme === 'dark') {
        htmlElement.setAttribute("data-bs-theme", "dark");
        window.dispatchEvent(new CustomEvent('echo-theme-applied', { detail: { theme } }));
        return;
    }
    htmlElement.removeAttribute("data-bs-theme");
    window.dispatchEvent(new CustomEvent('echo-theme-applied', { detail: { theme } }));
}

function applyTheme(themeMode: string, options?: { withLoader?: boolean }) {
    const requestToken = ++themeApplyRequestToken;
    const nextTheme = getResolvedTheme(themeMode);
    const currentTheme = getCurrentAppliedTheme();

    resetThemeSwitchUi();

    if (!options?.withLoader || nextTheme === currentTheme) {
        applyResolvedTheme(nextTheme);
        return;
    }

    const overlay = ensureThemeSwitchUi();
    const showDelayMs = 90;
    const minVisibleMs = 500;
    let overlayShownAt = 0;
    let overlayVisible = false;
    let hideTimer = 0;
    let finished = false;

    const finish = () => {
        if (finished) {
            return;
        }
        finished = true;
        window.clearTimeout(showTimer);
        window.clearTimeout(hideTimer);

        if (themeApplyRequestToken !== requestToken) {
            return;
        }

        if (overlayVisible) {
            overlay.classList.remove('visible');
        }
        document.documentElement.classList.remove('theme-switching');
    };

    const showTimer = window.setTimeout(() => {
        if (themeApplyRequestToken !== requestToken) {
            return;
        }
        overlayVisible = true;
        overlayShownAt = performance.now();
        overlay.classList.add('visible');
    }, showDelayMs);

    document.documentElement.classList.add('theme-switching');

    applyResolvedTheme(nextTheme);

    requestAnimationFrame(() => {
        if (themeApplyRequestToken !== requestToken) {
            finish();
            return;
        }

        if (!overlayVisible) {
            finish();
            return;
        }

        const elapsed = performance.now() - overlayShownAt;
        if (elapsed >= minVisibleMs) {
            finish();
            return;
        }

        hideTimer = window.setTimeout(finish, minVisibleMs - elapsed);
    });
}

function applyCurrentTheme() {
    // Get current theme from localStorage or use system preference
    const savedTheme = localStorage.getItem('echo-theme-mode');
    if (savedTheme) {
        applyTheme(savedTheme);
    } else {
        // No saved theme, use system preference
        const systemTheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        applyTheme(systemTheme);
    }
}

function setAppShellNavbarHeightVar(heightPx: number): void {
    if (!Number.isFinite(heightPx) || heightPx <= 0) {
        return;
    }
    document.documentElement.style.setProperty('--app-shell-navbar-height', `${Math.ceil(heightPx)}px`);
}

function createNavbarHeightSync() {
    let observedNavbar: HTMLElement | null = null;
    let rafId = 0;
    const resizeObserver = typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            scheduleSync();
        })
        : null;

    const syncNavbar = () => {
        rafId = 0;
        const navbar = document.getElementById('app-navbar-shell') as HTMLElement | null;

        if (navbar !== observedNavbar) {
            if (observedNavbar && resizeObserver) {
                resizeObserver.unobserve(observedNavbar);
            }
            observedNavbar = navbar;
            if (observedNavbar && resizeObserver) {
                resizeObserver.observe(observedNavbar);
            }
        }

        if (observedNavbar) {
            setAppShellNavbarHeightVar(observedNavbar.getBoundingClientRect().height);
        }
    };

    const scheduleSync = () => {
        if (rafId !== 0) {
            return;
        }
        rafId = window.requestAnimationFrame(syncNavbar);
    };

    const mutationObserver = new MutationObserver(() => {
        scheduleSync();
    });
    // We only need to detect navbar mount/unmount/replacement, not every style/class mutation in the app.
    mutationObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

    window.addEventListener('resize', scheduleSync, { passive: true });
    window.addEventListener('orientationchange', scheduleSync, { passive: true });

    syncNavbar();
    requestAnimationFrame(() => {
        scheduleSync();
        setTimeout(scheduleSync, 350);
    });

    return scheduleSync;
}

// Listen for system theme changes
if (window.matchMedia) {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', (e) => {
        // Only apply system theme if current theme is set to 'system'
        const currentTheme = localStorage.getItem('echo-theme-mode');
        if (currentTheme === 'system') {
            const newSystemTheme = e.matches ? 'dark' : 'light';
            applyTheme(newSystemTheme);
        }
    });
}

function td_propose_icons(search, description) {
    return search.search(description).map((x: any) => x.icon).slice(0, 8);
};
async function loadDescriptionIconTitle(search) {
    const response = await fetch('/data/description-icon-title.json');
    const documents = await response.json();
    search.addDocuments(documents);
}
let search: any = null;
import('../static/js-search').then(module => {
    search = new module.Search('icon');
    search.addIndex('title');
    search.addIndex('descrption');
    search.addIndex('icon');




    if (window.location.pathname.endsWith("/importer")) {
        loadDescriptionIconTitle(search)
    } else {
        if (window.navigation) {
            const navHandler = async (event) => {
                if (event.destination.url.endsWith("/importer")) {
                    await loadDescriptionIconTitle(search)
                    window.navigation.removeEventListener("navigate", navHandler);
                }
            }

            window.navigation.addEventListener("navigate", navHandler)

        } else {
            // fallback for firefox and safari (Navigation API is not implemented there yet)
            loadDescriptionIconTitle(search)
        }
    }
})





// This is called BEFORE your Elm app starts up
//
// The value returned here will be passed as flags
// into your `Shared.init` function.
export const flags = ({ env }) => {
    const isDark = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const now = dayjs().tz('Europe/Kiev').valueOf();
    return {
        "isDark": isDark,
        "now": now,
        "featureNavbarFrontOnly": false // Feature flag for navbar styling
    };

}

// This is called AFTER your Elm app starts up
//
// Here you can work with `app.ports` to send messages
// to your Elm application, or subscribe to incoming
// messages from Elm
export const onReady = ({ app, env }) => {
    // Apply initial theme based on localStorage or system preference
    applyCurrentTheme();
    const syncNavbarHeight = createNavbarHeightSync();

    setupCommentDraftTracker();

    if (app.ports && app.ports.home_usk2000ToWgs84 && app.ports.home_usk2000ToWgs84Res) {
        app.ports.home_usk2000ToWgs84.subscribe(({ coords }) => {
            let res = td_usk2000_to_wgs84(coords);
            let res_latlng = { lat: res.x, lng: res.y };
            let arg = { coords: res_latlng };
            app.ports.home_usk2000ToWgs84Res.send(arg);
        });
    }

    if (app.ports && app.ports.home_mgrsToWgs84 && app.ports.home_mgrsToWgs84Res) {
        app.ports.home_mgrsToWgs84.subscribe(({ coords }) => {
            let res = inverse(coords);
            let res_latlng = { lat: res[1], lng: res[0] };
            let arg = { coords: res_latlng };
            app.ports.home_mgrsToWgs84Res.send(arg);
        });
    }

    if (app.ports && app.ports.home_wgs84ToUsk2000 && app.ports.home_wgs84ToUsk2000Res) {
        app.ports.home_wgs84ToUsk2000.subscribe(({ coords }) => {
            let res = td_wgs84_to_usk2000({ y: coords.lat, x: coords.lng });
            let res_xy = { x: Math.round(res.y), y: Math.round(res.x) };
            let arg = { coords: res_xy };
            app.ports.home_wgs84ToUsk2000Res.send(arg);
        });
    }

    if (app.ports && app.ports.home_wgs84ToMgrs && app.ports.home_wgs84ToMgrsRes) {
        app.ports.home_wgs84ToMgrs.subscribe(({ coords, viewId }) => {
            let res = forward([coords.lng, coords.lat]);
            let arg = { coords: res, viewId };
            app.ports.home_wgs84ToMgrsRes.send(arg);
        });
    }

    if (app.ports && app.ports.importer_usk2000ToWgs84 && app.ports.importer_usk2000ToWgs84Res) {
        app.ports.importer_usk2000ToWgs84.subscribe(({ rowId, coordId, coords }) => {
            let res = td_usk2000_to_wgs84(coords);
            let res_latlng = { lat: res.x, lng: res.y };
            let arg = {
                rowId: rowId,
                coordId: coordId,
                coords: res_latlng
            };
            app.ports.importer_usk2000ToWgs84Res.send(arg);
        });
    }

    if (app.ports && app.ports.importer_proposeIcons && app.ports.importer_proposeIconsRes) {
        app.ports.importer_proposeIcons.subscribe(({ rowId, text }) => {
            let res = td_propose_icons(search, text);
            let arg = {
                rowId: rowId,
                icons: res
            };
            app.ports.importer_proposeIconsRes.send(arg);
        });
    }

    let td_arrayBufferToBase64 = function(buffer) {
        let binary = '';
        let bytes = new Uint8Array(buffer);
        let len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }

    if (app.ports && app.ports.importer_pasteImage && app.ports.importer_pasteImageRes) {
        app.ports.importer_pasteImage.subscribe(({ rowId }) => {
            navigator.clipboard.read().then((contents) => {
                for (const item of contents) {
                    if (item.types.includes('image/png')) {
                        item.getType('image/png').then((blob) => {
                            blob.arrayBuffer().then((arr) => {
                                let contentsBase64 = td_arrayBufferToBase64(arr);
                                let arg = { rowId: rowId, contentsBase64: contentsBase64 };
                                app.ports.importer_pasteImageRes.send(arg);
                            });
                        });
                    }
                }
            });
        });
    }

    if (app.ports && app.ports.rer_importer_focus) {
        app.ports.rer_importer_focus.subscribe(({ elemId }) => {
            requestAnimationFrame(
                () => {
                    document.getElementById(elemId)?.focus();
                });
        });
    }

    if (app.ports && app.ports.port_focusHtmlElement) {
        app.ports.port_focusHtmlElement.subscribe(({ elemId }) => {
            requestAnimationFrame(
                () => {
                    document.getElementById(elemId)?.focus();
                });
        });
    }

    if (app.ports && app.ports.port_scrollToElement) {
        app.ports.port_scrollToElement.subscribe(({ elemId, x, y }) => {
            requestAnimationFrame(
                () => {
                    let el = document.getElementById(elemId);
                    el?.scrollTo({ top: y, left: x, behavior: "instant" });
                });
        });
    }

    if (app.ports && app.ports.waterfall_scrollIntoView) {
        app.ports.waterfall_scrollIntoView.subscribe(({ elemId, height, waterfallId }) => {
            requestAnimationFrame(
                () => {
                    const el = document.getElementById(elemId);
                    const waterfall = document.getElementById(waterfallId);
                    if (el) {
                        const notVisibleHeight = el.offsetHeight - height

                        el.scrollIntoView({ behavior: "instant", block: "start", inline: "nearest" });

                        if (waterfall) {
                            waterfall.scrollBy({ behavior: "instant", top: notVisibleHeight })
                        }
                    }

                });
        });

    }
    if (app.ports && app.ports.waterfall_scrollTo) {
        app.ports.waterfall_scrollTo.subscribe(({ elemId, x, y }) => {
            requestAnimationFrame(
                () => {
                    let el = document.getElementById(elemId);
                    el?.scrollTo({ top: y, left: x, behavior: "instant" });
                });
        });
    }

    if (app.ports && app.ports.waterfall_copyTextToClipboard) {
        app.ports.waterfall_copyTextToClipboard.subscribe(({ text }) => {
            copyTextToClipboard(text);
        });
    }

    function copyTextToClipboard(text: string) {
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).catch(() => fallbackCopyTextToClipboard(text));
            return;
        }
        fallbackCopyTextToClipboard(text);
    }

    // When copy runs, the user's click has often already finished (Elm sent to port). Browser then
    // throws "Document is not focused" error. This workaround is a fallback for that.
    function fallbackCopyTextToClipboard(text: string) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try {
            document.execCommand('copy');
        } finally {
            document.body.removeChild(ta);
        }
    }

    if (app.ports && app.ports.waterfall_getVisibleMsgIds && app.ports.waterfall_getVisibleMsgIdsRes) {
        app.ports.waterfall_getVisibleMsgIds.subscribe(({ waterfallId, allMsgIds }: { waterfallId: string, allMsgIds: number[] }) => {
            const waterfallElement = document.getElementById(`waterfall-${waterfallId}`);

            if (waterfallElement) {

                const waterfallPosTop = waterfallElement.getBoundingClientRect().top;

                const viewportTop = window.scrollY + waterfallPosTop;
                const viewportBottom = viewportTop + window.innerHeight;

                const isVisible = (index) => {
                    const msgId = allMsgIds[index];
                    const elem = document.getElementById(`waterfall-${waterfallId}-message-${msgId}`);

                    if (elem) {
                        const elemTop = elem.getBoundingClientRect().top + window.scrollY;
                        const elemBottom = elemTop + elem.offsetHeight;

                        const isPartiallyVisible = (elemBottom > viewportTop) && (elemTop < viewportBottom);

                        const visibleTop = Math.max(elemTop, viewportTop)
                        const visibleBottom = Math.min(elemBottom, viewportBottom)
                        const visibleHeight = Math.max(0, visibleBottom - visibleTop)

                        return {
                            visible: isPartiallyVisible,
                            elemTop,
                            elemBottom,
                            visibleHeight
                        };
                    }
                    return { visible: false, elemTop: null, elemBottom: null, visibleHeight: 0 };
                };

                const findVisibleTopToBottom = (index) => {
                    let bottom = index;
                    let top = index;

                    while (isVisible(bottom - 1).visible && bottom >= 0) {
                        bottom--;
                    }
                    while (isVisible(top + 1).visible && top < allMsgIds.length) {
                        top++;
                    }

                    return { bottom, top };
                };

                const visibleMsgIds: number[] = [];
                let firstVisibleIndex: number;

                let left = 0
                let right = allMsgIds.length - 1

                while (left <= right) {
                    const mid = Math.floor((left + right) / 2)
                    const currentMessage = isVisible(mid);

                    if (currentMessage.visible) {
                        const { bottom, top } = findVisibleTopToBottom(mid);
                        for (let j = bottom; j <= top; j++) {
                            visibleMsgIds.push(allMsgIds[j]);
                        }
                        firstVisibleIndex = bottom;
                        break;
                    }

                    if (currentMessage.elemTop !== null && currentMessage.elemTop >= viewportTop) {
                        right = mid - 1
                    } else {

                        left = mid + 1
                    }

                }
                //@ts-ignore
                const firstMessageVisibility = isVisible(firstVisibleIndex);
                const firstVisibleHeight = firstMessageVisibility.visible ? firstMessageVisibility.visibleHeight : 0;

                app.ports.waterfall_getVisibleMsgIdsRes.send({ waterfallId, msgIds: visibleMsgIds, firstVisibleHeight });
            }
        });
    }

    window.netjson_graphs = {};

    let scriptLoaded = false;

    const loadScript = () => {
        if (!scriptLoaded) {
            scriptLoaded = true;
            return import("../static/netjsongraph/netjsongraph.min.js")
        }
        return Promise.resolve();
    };
    if (app.ports && app.ports.port_initNetjsonGraph) {
        app.ports.port_initNetjsonGraph.subscribe(({ elemId, graphDataAndMeta }) => {
            loadScript().then(() => {
                let graphData = graphDataAndMeta.graph;
                graphData.type = graphData.type_;

                let graph;
                if (elemId in window.netjson_graphs) {
                    graph = window.netjson_graphs[elemId];
                    graph.utils.JSONDataUpdate(graphData);
                } else {
                    graph = new NetJSONGraph(graphData, {
                        el: document.getElementById(elemId),
                        graphConfig: {
                            series: {
                                nodeSize: (node) => {
                                    if (node.count <= 20) {
                                        return Math.sqrt(node.count) * 4;
                                    } else {
                                        return 20 + Math.log(node.count);
                                    }
                                }
                            },
                            baseOptions: {
                                backgroundColor: "#211a11",
                            }
                        },
                        linkCategories: graphDataAndMeta.linkCategories,
                    });
                }
                graph.render();

            })
        });

    }

    if (app.ports && app.ports.shared_toggleDarkMode) {
        app.ports.shared_toggleDarkMode.subscribe(() => {
            // This port is now used for applying theme changes
            // The actual theme mode is managed by the new system
            applyCurrentTheme();
        });
    }

    if (app.ports && app.ports.shared_saveThemeMode) {
        app.ports.shared_saveThemeMode.subscribe((themeMode: string) => {
            // Save theme mode to localStorage
            localStorage.setItem('echo-theme-mode', themeMode);
            // Apply the theme immediately
            applyTheme(themeMode, { withLoader: true });
        });
    }

    if (app.ports && app.ports.shared_loadThemeMode) {
        app.ports.shared_loadThemeMode.subscribe(() => {
            // Load theme mode from localStorage
            const savedTheme = localStorage.getItem('echo-theme-mode');
            if (savedTheme) {
                app.ports.shared_loadThemeModeRes.send(savedTheme);
            } else {
                // No saved theme, use system preference
                const systemTheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                app.ports.shared_loadThemeModeRes.send(systemTheme);
            }
        });
    }

    if (app.ports && app.ports.shared_triggerResize) {
        app.ports.shared_triggerResize.subscribe(() => {
            // Use requestAnimationFrame to ensure DOM changes are applied first
            requestAnimationFrame(() => {
                // Then add a delay to allow CSS transitions to complete
                setTimeout(() => {
                    syncNavbarHeight();
                    window.dispatchEvent(new Event('resize'));
                }, 300); // Match the transition duration from CSS
            });
        });
    }


    if (app.ports && app.ports.shared_getLocation && app.ports.shared_getLocationRes) {
        app.ports.shared_getLocation.subscribe(() => {
            let loc = window.location;
            let res = {
                host: loc.host,
                hostname: loc.hostname,
                href: loc.href,
                origin: loc.origin,
                pathname: loc.pathname,
                port_: loc.port,
                protocol: loc.protocol,
                search: loc.search,
                hash: loc.hash
            };
            app.ports.shared_getLocationRes.send(res);
        });
    }

    if (app.ports && app.ports.importer_mgrsToWgs84 && app.ports.importer_mgrsToWgs84Res) {
        app.ports.importer_mgrsToWgs84.subscribe(({ rowId, coordId, coords }) => {
            let res = inverse(coords);
            let res_latlng = { lat: res[1], lng: res[0] };
            let arg = {
                rowId: rowId,
                coordId: coordId,
                coords: res_latlng
            };
            app.ports.importer_mgrsToWgs84Res.send(arg);
        });
    }

    if (app.ports && app.ports.shared_loadScript) {
        let presentScripts = document.getElementsByTagName('script');
        app.ports.shared_loadScript.subscribe(function(url) {
            for (let i = 0; i < presentScripts.length; i++) {
                if (presentScripts[i].src.endsWith(url)) {
                    app.ports.shared_loadScriptRes.send(url);
                    return;
                }
            };

            const script = document.createElement('script');
            script.src = url;
            script.onload = function() {
                app.ports.shared_loadScriptRes.send(url);
                presentScripts = document.getElementsByTagName('script');
            };
            document.body.appendChild(script);
        });
    }

    if (app.ports && app.ports.rer_analysis_saveQueryState) {
        app.ports.rer_analysis_saveQueryState.subscribe((queryState: unknown) => {
            saveRerAnalysisQueryState(queryState);
        });
    }

    if (
        app.ports &&
        app.ports.rer_callsigns_neo_saveBetaBannerDismissed &&
        app.ports.rer_callsigns_neo_loadBetaBannerDismissed &&
        app.ports.rer_callsigns_neo_loadBetaBannerDismissedRes
    ) {
        app.ports.rer_callsigns_neo_saveBetaBannerDismissed.subscribe((isDismissed: boolean) => {
            sessionStorage.setItem(
                RER_CALLSIGNS_NEO_BETA_BANNER_DISMISSED_KEY,
                isDismissed ? '1' : '0'
            );
        });

        app.ports.rer_callsigns_neo_loadBetaBannerDismissed.subscribe(() => {
            const storedValue = sessionStorage.getItem(RER_CALLSIGNS_NEO_BETA_BANNER_DISMISSED_KEY);
            app.ports.rer_callsigns_neo_loadBetaBannerDismissedRes.send(storedValue === '1');
        });
    }


    if (app.ports && app.ports.rer_freqs_openMap && app.ports.rer_freqs_closeMapRes) {
        app.ports.rer_freqs_openMap.subscribe(function(data: { points: MapPointShort[]; containerId: string }) {
            if (data.points.length > 0) {
                setupMap(data, () => app.ports.rer_freqs_closeMapRes.send(data.containerId))
            }
        });

    }

}
