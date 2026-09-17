/**
 * @vitest-environment happy-dom
 */
import { beforeAll, describe, expect, it } from 'vitest';

const ENTRYPOINTS = [
  { modulePath: './control-panel-neo-element', tag: 'control-panel-neo' },
  { modulePath: './organisms-neo-element', tag: 'organisms-neo' },
  { modulePath: './organisms-neo-edit-element', tag: 'organisms-neo-edit' },
  { modulePath: './rer-callsigns-neo-element', tag: 'rer-callsigns-neo' },
  { modulePath: './rer-analysis-neo-element', tag: 'rer-analysis-neo' },
  { modulePath: './rer-network-details-neo-element', tag: 'rer-network-details-neo' },
  { modulePath: './devices-page-element', tag: 'devices-page' },
  { modulePath: './device-details-page-element', tag: 'device-details-page' },
  { modulePath: './rer-networks-neo-element', tag: 'rer-networks-neo' },
  { modulePath: './rer-units-neo-element', tag: 'rer-units-neo' },
  { modulePath: './unit-attachment-upload-element', tag: 'unit-attachment-upload' },
  { modulePath: './orbit-unit-link-dialog-element', tag: 'orbit-unit-link-dialog' },
  { modulePath: './unit-edit-dialog-element', tag: 'unit-edit-dialog' },
  { modulePath: './tags-neo-element', tag: 'tags-neo' },
  { modulePath: './admin-all-reports-element', tag: 'admin-all-reports' },
  { modulePath: './admin-report-details-element', tag: 'admin-report-details' },
  { modulePath: './admin-unit-duplicates-element', tag: 'admin-unit-duplicates' },
  { modulePath: './admin-unit-inconsistent-element', tag: 'admin-unit-inconsistent' },
  { modulePath: './admin-unit-unparsed-element', tag: 'admin-unit-unparsed' },
  { modulePath: './admin-unparsed-units-element', tag: 'admin-unparsed-units' },
  { modulePath: './admin-units-element', tag: 'admin-units' },
  { modulePath: './admin-ai-callsigns-element', tag: 'admin-ai-callsigns' },
  { modulePath: './admin-device-analytics-element', tag: 'admin-device-analytics' },
  { modulePath: './admin-ai-agent-element', tag: 'admin-ai-agent' },
  { modulePath: './ai-agent-chat-element', tag: 'ai-agent-chat' },
  { modulePath: './admin-echo-missing-messages-element', tag: 'admin-echo-missing-messages' },
  { modulePath: './admin-directions-neo-element', tag: 'admin-directions-neo' },
  { modulePath: './transcription-settings-element', tag: 'transcription-settings' },
  { modulePath: './goi-knowledge-element', tag: 'goi-knowledge' },
  { modulePath: './goi-integrations-neo-element', tag: 'goi-integrations-neo' },
  { modulePath: './api-integrations-element', tag: 'api-integrations' },
  { modulePath: './goi-settings-element', tag: 'goi-settings' },
  { modulePath: './rer-palitra-neo-element', tag: 'rer-palitra-neo' },
  { modulePath: './tags-neo-keyword-edit-element', tag: 'tags-neo-keyword-edit' },
  { modulePath: './location-config-neo-element', tag: 'location-config-neo' },
  { modulePath: './users-neo-element', tag: 'users-neo' },
  { modulePath: './admin-user-details-element', tag: 'admin-user-details' },
  { modulePath: './analysis-map-layer-switch-element', tag: 'analysis-map-layer-switch' },
  { modulePath: './analysis-map-search-element', tag: 'analysis-map-search' },
  { modulePath: './rer-duty-neo-element', tag: 'rer-duty-neo' },
  { modulePath: './analysis-map-settings-element', tag: 'analysis-map-settings' },
  { modulePath: './analysis-map-window-control-element', tag: 'analysis-map-window-control' },
  { modulePath: './keys-neo-element', tag: 'keys-neo' },
  { modulePath: './messenger-neo-element', tag: 'messenger-neo' },
  { modulePath: './settings-neo-element', tag: 'settings-neo' },
  { modulePath: './goi-associations-element', tag: 'goi-associations' },
  { modulePath: './analysis-count-chip-element', tag: 'analysis-count-chip' },
  { modulePath: './aor-neo-form-element', tag: 'aor-neo-form' },
  { modulePath: './tags-neo-edit-element', tag: 'tags-neo-edit' },
  { modulePath: './analysis-map-palitras-element', tag: 'analysis-map-palitras' },
  { modulePath: './analysis-map-coord-menu-element', tag: 'analysis-map-coord-menu' },
  { modulePath: './aor-neo-element', tag: 'aor-neo' },
] as const;

describe('React custom element entrypoints', () => {
  beforeAll(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
        clear: () => {
          storage.clear();
        },
      },
    });
  });

  it('does not register the removed Home loading card', () => {
    expect(customElements.get('home-loading-card')).toBeUndefined();
  });

  it.each(ENTRYPOINTS)(
    'registers $tag from $modulePath',
    async ({ modulePath, tag }) => {
      await import(modulePath);
      expect(customElements.get(tag)).toBeDefined();
    },
    20000,
  );
});
