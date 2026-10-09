const released = new WeakSet<HTMLMediaElement>();

export function releaseNativeMedia(element: HTMLMediaElement) {
  if (released.has(element)) return;
  released.add(element);
  element.pause();
  element.removeAttribute('src');
  element.load();
}
