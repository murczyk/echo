export type NavigationNavigateEvent = {
  destination: {
    url: string;
    key?: string;
    index?: number;
  };
  navigationType?: 'push' | 'replace' | 'traverse' | 'reload';
  canIntercept?: boolean;
  downloadRequest?: string | null;
  formData?: FormData | null;
};

export type NavigationApi = {
  addEventListener: (
    type: 'navigate' | 'navigatesuccess',
    listener: EventListenerOrEventListenerObject,
  ) => void;
  removeEventListener: (
    type: 'navigate' | 'navigatesuccess',
    listener: EventListenerOrEventListenerObject,
  ) => void;
  currentEntry?: { index: number; key: string; url?: string };
  entries?: () => { index: number; key: string; url?: string }[];
  traverseTo?: (key: string) => { finished: Promise<unknown> };
};

export function getNavigationApi(): NavigationApi | undefined {
  return 'navigation' in window ? (window.navigation as NavigationApi | undefined) : undefined;
}
