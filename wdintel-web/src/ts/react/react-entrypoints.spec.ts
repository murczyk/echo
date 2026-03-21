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
  { modulePath: './tags-neo-element', tag: 'tags-neo' },
  { modulePath: './admin-directions-neo-element', tag: 'admin-directions-neo' },
  { modulePath: './goi-knowledge-element', tag: 'goi-knowledge' },
  { modulePath: './rer-palitra-neo-element', tag: 'rer-palitra-neo' },
  { modulePath: './tags-neo-keyword-edit-element', tag: 'tags-neo-keyword-edit' },
  { modulePath: './location-config-neo-element', tag: 'location-config-neo' },
  { modulePath: './users-neo-element', tag: 'users-neo' },
  { modulePath: './analysis-map-layer-switch-element', tag: 'analysis-map-layer-switch' },
  { modulePath: './analysis-map-search-element', tag: 'analysis-map-search' },
  { modulePath: './rer-duty-neo-element', tag: 'rer-duty-neo' },
  { modulePath: './analysis-map-settings-element', tag: 'analysis-map-settings' },
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

  it.each(ENTRYPOINTS)('registers $tag from $modulePath', async ({ modulePath, tag }) => {
    await import(modulePath);
    expect(customElements.get(tag)).toBeDefined();
  });
});
