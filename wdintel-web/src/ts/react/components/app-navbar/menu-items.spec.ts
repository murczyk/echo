import { describe, expect, it } from 'vitest';
import {
  adminDatabaseSubs,
  adminSubs,
  aiAgentAdminSubs,
  getDatabaseSubs,
  goiExternalUrl,
  isActiveName,
  menuIsActive,
  type Menu,
} from './menu-items';

describe('menu-items', () => {
  describe('isActiveName', () => {
    it('matches exact active names', () => {
      expect(isActiveName('rer-duty', 'rer-duty')).toBe(true);
      expect(isActiveName('rer-duty', 'rer-analysis')).toBe(false);
    });

    it('matches settings-neo prefix', () => {
      expect(isActiveName('settings-neo', 'settings-neo-duty')).toBe(true);
      expect(isActiveName('settings-neo', 'settings-neo-analysis')).toBe(true);
      expect(isActiveName('settings', 'settings-neo-duty')).toBe(false);
    });
  });

  describe('menuIsActive', () => {
    it('checks item menus', () => {
      const itemMenu: Menu = {
        type: 'item',
        link: { type: 'internal', path: '/test' },
        activeName: 'test-active',
        label: 'Test',
      };
      expect(menuIsActive('test-active', itemMenu)).toBe(true);
      expect(menuIsActive('other-active', itemMenu)).toBe(false);
    });

    it('checks group menus recursively', () => {
      const groupMenu: Menu = {
        type: 'group',
        label: 'Group',
        subs: [
          {
            type: 'item',
            link: { type: 'internal', path: '/test1' },
            activeName: 'test-1',
            label: 'Test 1',
          },
          {
            type: 'item',
            link: { type: 'internal', path: '/test2' },
            activeName: 'test-2',
            label: 'Test 2',
          },
          { type: 'separator' },
        ],
      };
      expect(menuIsActive('test-2', groupMenu)).toBe(true);
      expect(menuIsActive('test-3', groupMenu)).toBe(false);
    });

    it('returns false for separators', () => {
      expect(menuIsActive('anything', { type: 'separator' })).toBe(false);
    });
  });

  describe('getDatabaseSubs', () => {
    it('keeps RER database items without Devices by default', () => {
      const subs = getDatabaseSubs({ includeRerItems: true, includeDevicesItem: false });
      expect(subs.map((item) => (item.type === 'item' ? item.label : item.type))).toContain(
        'Мережі',
      );
      expect(subs.map((item) => (item.type === 'item' ? item.label : item.type))).not.toContain(
        'Пристрої',
      );
    });

    it('places Devices immediately after Callsigns when both gates are visible', () => {
      const labels = getDatabaseSubs({ includeRerItems: true, includeDevicesItem: true }).map(
        (item) => (item.type === 'item' ? item.label : item.type),
      );
      expect(labels.slice(3, 5)).toEqual(['Позивні', 'Пристрої']);
    });

    it('renders Devices as the only database item for non-RER Devices readers', () => {
      const labels = getDatabaseSubs({ includeRerItems: false, includeDevicesItem: true }).map(
        (item) => (item.type === 'item' ? item.label : item.type),
      );
      expect(labels).toEqual(['Пристрої']);
      expect(getDatabaseSubs({ includeRerItems: false, includeDevicesItem: false })).toEqual([]);
    });
  });

  describe('goiExternalUrl', () => {
    it('returns null for empty strings', () => {
      expect(goiExternalUrl('')).toBeNull();
      expect(goiExternalUrl('   ')).toBeNull();
    });

    it('prepends https:// if missing', () => {
      expect(goiExternalUrl('example.com')).toBe('https://example.com');
      expect(goiExternalUrl('test.net/path')).toBe('https://test.net/path');
    });

    it('preserves existing http/https prefix', () => {
      expect(goiExternalUrl('https://example.com')).toBe('https://example.com');
      expect(goiExternalUrl('http://insecure.com')).toBe('http://insecure.com');
      expect(goiExternalUrl('HTTPS://UPPER.COM')).toBe('HTTPS://UPPER.COM');
    });
  });

  it('alphabetizes standalone admin items while keeping system settings last', () => {
    expect(adminSubs.filter((item) => item.type === 'item').map((item) => item.label)).toEqual([
      'Користувачі',
      'Месенджери',
      'Напрямки',
      'Організми',
      'Смуги',
      'Налаштування системи',
    ]);
  });

  it('exposes the first-class ШІ administration sections', () => {
    expect(aiAgentAdminSubs.flatMap((item) => (item.type === 'item' ? [item.label] : []))).toEqual([
      'Диспетчер',
      'Запити',
      'Зворотні проксі',
      'Контейнери',
      'Налаштування ШІ',
      'Позивні',
      'Провайдери',
    ]);

    const aiGroupIndex = adminSubs.findIndex(
      (item) => item.type === 'group' && item.label === 'ШІ',
    );
    const aiGroup = adminSubs[aiGroupIndex];
    expect(aiGroup).toEqual({ type: 'group', label: 'ШІ', subs: aiAgentAdminSubs });
    expect(adminSubs[aiGroupIndex - 1]).toEqual({ type: 'separator' });
    expect(adminSubs[aiGroupIndex + 1]).toEqual({ type: 'separator' });
    if (!aiGroup) throw new Error('ШІ group was not found');
    expect(menuIsActive('ai-agent-requests', aiGroup)).toBe(true);
  });

  it('groups admin import links under Імпорт', () => {
    const importGroup = adminSubs.find(
      (item): item is Extract<Menu, { type: 'group' }> =>
        item.type === 'group' && item.label === 'Імпорт',
    );

    expect(importGroup?.subs).toEqual([
      {
        type: 'item',
        link: { type: 'internal', path: '/admin/rer-csv-import' },
        activeName: 'rer-csv-import',
        label: 'Імпорт CSV',
      },
      {
        type: 'item',
        link: { type: 'internal', path: '/admin/rer-delta-import' },
        activeName: 'rer-delta-import',
        label: 'Імпорт Delta',
      },
    ]);
    expect(menuIsActive('rer-delta-import', importGroup!)).toBe(true);
  });

  it('groups the database administration block under База знань', () => {
    const databaseGroup = adminSubs.find(
      (item): item is Extract<Menu, { type: 'group' }> =>
        item.type === 'group' && item.label === 'База знань',
    );

    expect(databaseGroup?.subs).toBe(adminDatabaseSubs);
    expect(
      databaseGroup?.subs.flatMap((item) => (item.type === 'item' ? [item.label] : [])),
    ).toEqual([
      'Echo GPU сервери',
      'Аналіз пристроїв',
      'Всі звіти',
      'ГОІ',
      'Інтеграції API',
      'Карта',
      'Ключі',
      'Населені пункти смуг',
      'Підрозділи',
      'Теги',
    ]);
    expect(menuIsActive('tags-neo', databaseGroup!)).toBe(true);
    expect(menuIsActive('device-analytics', databaseGroup!)).toBe(true);
    expect(menuIsActive('battle-line', databaseGroup!)).toBe(true);
    expect(
      adminSubs.some((item) => item.type === 'item' && item.activeName === 'device-analytics'),
    ).toBe(false);
    expect(
      adminSubs.some((item) => item.type === 'item' && item.activeName === 'battle-line'),
    ).toBe(false);
  });
});
