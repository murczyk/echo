import { createRoot, type Root } from 'react-dom/client';

import { DebugRecorderPanel, type DebugRecorderPanelController } from './DebugRecorderPanel';

const ROOT_ID = 'echo-debug-recorder-root';

let reactRoot: Root | null = null;
let host: HTMLElement | null = null;

export function mountDebugRecorderPanel(controller: DebugRecorderPanelController): void {
  if (typeof document === 'undefined' || !document.body) return;
  if (!host) {
    host = document.getElementById(ROOT_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = ROOT_ID;
      document.body.append(host);
    }
    host.dataset.debugRecorderRoot = '';
  }
  if (!reactRoot) reactRoot = createRoot(host);
  reactRoot.render(<DebugRecorderPanel controller={controller} />);
}

export function unmountDebugRecorderPanel(): void {
  reactRoot?.unmount();
  reactRoot = null;
  host?.remove();
  host = null;
}
