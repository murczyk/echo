import { useCallback, useState } from 'react';

// Elm routes `/rer-analysis-neo/` and `/rer-analysis-neo` to the same mounted page.
function routePathname(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

// SPA navigation commits the next URL and dispatches popstate before Elm unmounts the page,
// so the page must stop reading and writing the URL once the window has left its route.
export function useRouteUrlOwnership(): () => boolean {
  const [ownPathname] = useState(() => routePathname(window.location.pathname));
  return useCallback(() => routePathname(window.location.pathname) === ownPathname, [ownPathname]);
}
