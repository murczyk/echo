export enum ClientRequestTrigger {
  Automatic = 'automatic',
  Manual = 'manual',
  Validation = 'validation',
}

const clientAsset = new URL(import.meta.url).pathname.split('/').pop()?.slice(0, 96) ?? 'unknown';
let tabId: string | undefined;

export function requestDiagnostics(url: string): Record<string, string> {
  if (
    typeof document === 'undefined' ||
    !/^\/api\/(?:rer-importer\/(?:get-inbox|messages-by-id)|rer\/analysis\/|event-stream\/long-poll)/.test(
      url,
    )
  ) {
    return {};
  }
  tabId ??=
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return {
    'x-echo-client-asset': clientAsset,
    'x-echo-tab-id': tabId,
    'x-echo-page-visibility': document.visibilityState,
  };
}
