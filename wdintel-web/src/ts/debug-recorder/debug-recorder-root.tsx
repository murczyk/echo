import { createRoot, type Root } from 'react-dom/client';

import { DEBUG_RECORDER_SLOT_ID } from './config';
import { DebugRecorderPanel, type DebugRecorderPanelController } from './DebugRecorderPanel';

const ROOT_ID = 'echo-debug-recorder-root';

let reactRoot: Root | null = null;
let host: HTMLElement | null = null;

export function mountDebugRecorderPanel(controller: DebugRecorderPanelController): void {
  if (typeof document === 'undefined' || !document.body) return;
  const target = document.getElementById(DEBUG_RECORDER_SLOT_ID) ?? document.body;
  if (host && !host.isConnected) {
    reactRoot?.unmount();
    reactRoot = null;
    host = null;
  }
  if (!host) {
    host = document.getElementById(ROOT_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = ROOT_ID;
      document.body.append(host);
    }
    host.dataset.debugRecorderHost = '';
  }
  if (host.parentElement !== target) target.append(host);
  if (!reactRoot) reactRoot = createRoot(host);
  reactRoot.render(<DebugRecorderPanel controller={controller} />);
}

export function unmountDebugRecorderPanel(): void {
  reactRoot?.unmount();
  reactRoot = null;
  host?.remove();
  host = null;
}
