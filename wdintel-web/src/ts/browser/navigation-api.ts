export type NavigationNavigateEvent = {
  destination: {
    url: string;
  };
};

export type NavigationApi = {
  addEventListener: (type: 'navigate', listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: 'navigate', listener: EventListenerOrEventListenerObject) => void;
};

export function getNavigationApi(): NavigationApi | undefined {
  return 'navigation' in window ? (window.navigation as NavigationApi | undefined) : undefined;
}
