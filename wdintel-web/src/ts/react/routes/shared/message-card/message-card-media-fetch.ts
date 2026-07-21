import { emitUnauthorizedEvent } from '../../../auth-redirect';

export function handleUnauthorizedMediaResponse(response: Response, requestUrl: string): void {
  if (response.status !== 401) return;
  if (requestUrl.startsWith('/') && !requestUrl.startsWith('//')) {
    emitUnauthorizedEvent();
    return;
  }

  const url = new URL(requestUrl, window.location.href);
  if (url.origin === window.location.origin) emitUnauthorizedEvent();
}
