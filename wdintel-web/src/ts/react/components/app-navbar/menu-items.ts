export type Link = { type: 'internal'; path: string } | { type: 'external'; link: string };

export type Menu =
  | { type: 'item'; link: Link; activeName: string; label: string }
  | { type: 'group'; label: string; subs: Menu[] }
  | { type: 'separator' };

export function isActiveName(itemActiveName: string, activeName: string) {
  return (
    itemActiveName === activeName ||
    (itemActiveName === 'settings-neo' && activeName.startsWith('settings-neo'))
  );
}

export function menuIsActive(activeName: string, menu: Menu): boolean {
  if (menu.type === 'item') {
    return isActiveName(menu.activeName, activeName);
  } else if (menu.type === 'group') {
    return menu.subs.some((sub) => menuIsActive(activeName, sub));
  }
  return false;
}

export function goiExternalUrl(rawHost: string): string | null {
  const host = rawHost.trim();
  if (!host) return null;
  return /^https?:\/\//i.test(host) ? host : `https://${host}`;
}

export const operationalSubs: Menu[] = [
  {
    type: 'item',
    link: { type: 'internal', path: '/rer-duty' },
    activeName: 'rer-duty',
    label: 'Класичний',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/rer-duty-neo' },
    activeName: 'rer-duty-neo',
    label: 'Новий',
  },
  { type: 'separator' },
  {
    type: 'item',
    link: { type: 'internal', path: '/settings-neo?section=duty' },
    activeName: 'settings-neo-duty',
    label: 'Налаштування',
  },
];

export const analysisSubs: Menu[] = [
  {
    type: 'item',
    link: { type: 'internal', path: '/rer-analysis' },
    activeName: 'analysis',
    label: 'Класичний',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/rer-analysis-neo' },
    activeName: 'rer-analysis-neo',
    label: 'Новий',
  },
  { type: 'separator' },
  {
    type: 'item',
    link: { type: 'external', link: '/docs' },
    activeName: 'documentation',
    label: 'Документація',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/group-activity' },
    activeName: 'group-activity',
    label: 'Статистика',
  },
  { type: 'separator' },
  {
    type: 'item',
    link: { type: 'internal', path: '/settings-neo?section=analysis' },
    activeName: 'settings-neo-analysis',
    label: 'Налаштування',
  },
];

const networksDatabaseSub: Menu = {
  type: 'item',
  link: { type: 'internal', path: '/rer-networks-neo' },
  activeName: 'networks-neo',
  label: 'Мережі',
};

export const devicesDatabaseSub: Menu = {
  type: 'item',
  link: { type: 'internal', path: '/devices' },
  activeName: 'devices',
  label: 'Пристрої',
};

export const databaseSubs: Menu[] = [
  networksDatabaseSub,
  {
    type: 'item',
    link: { type: 'internal', path: '/rer-palitra-neo' },
    activeName: 'palitra-neo',
    label: 'Палітри',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/rer-units' },
    activeName: 'rer-units',
    label: 'Підрозділи',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/rer-callsigns-neo' },
    activeName: 'callsigns-neo',
    label: 'Позивні',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/rer-signals' },
    activeName: 'rer-signals',
    label: 'Сигнали',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/rer-freqs' },
    activeName: 'rer-freqs',
    label: 'Частоти',
  },
];

export function getDatabaseSubs({
  includeRerItems,
  includeDevicesItem,
}: {
  includeRerItems: boolean;
  includeDevicesItem: boolean;
}): Menu[] {
  if (!includeRerItems) {
    return includeDevicesItem ? [devicesDatabaseSub] : [];
  }

  return includeDevicesItem
    ? [networksDatabaseSub, devicesDatabaseSub, ...databaseSubs.slice(1)]
    : databaseSubs;
}

export const converterSubs: Menu[] = [
  {
    type: 'item',
    link: { type: 'internal', path: '/importer' },
    activeName: 'importer',
    label: 'Імпортер',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/alpinequest-kmz' },
    activeName: 'alpinequest-kmz',
    label: 'AlpineQuest в KMZ',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/delta-csv2kmz' },
    activeName: 'delta-csv2kmz',
    label: 'Delta CSV в KMZ',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/delta' },
    activeName: 'delta',
    label: 'KMZ в GeoJSON',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/coords-converter' },
    activeName: 'coords-converter',
    label: 'Координати',
  },
];

export const aiAgentAdminSubs: Menu[] = [
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/ai/providers' },
    activeName: 'ai-agent-providers',
    label: 'Провайдери',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/ai/settings' },
    activeName: 'ai-agent-settings',
    label: 'Налаштування ШІ',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/ai/containers' },
    activeName: 'ai-agent-containers',
    label: 'Контейнери',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/ai/requests' },
    activeName: 'ai-agent-requests',
    label: 'Запити',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/ai/dispatcher' },
    activeName: 'ai-agent-dispatcher',
    label: 'Диспетчер',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/ai/echo-proxies' },
    activeName: 'ai-agent-echo-proxies',
    label: 'Зворотні проксі',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/ai/callsigns' },
    activeName: 'ai-agent-callsigns',
    label: 'Позивні',
  },
];

export const adminDatabaseSubs: Menu[] = [
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/api-integrations' },
    activeName: 'api-integrations',
    label: 'Інтеграції API',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/transcription-settings' },
    activeName: 'transcription-settings',
    label: 'Echo GPU Сервери',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/all-reports' },
    activeName: 'all-reports',
    label: 'Всі звіти',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/goi-integrations-neo' },
    activeName: 'goi-integrations-neo',
    label: 'ГОІ',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/keys-neo' },
    activeName: 'keys-neo',
    label: 'Ключі',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/location-configs-neo' },
    activeName: 'location-config-neo',
    label: 'Населені пункти смуг',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/tags-neo' },
    activeName: 'tags-neo',
    label: 'Теги',
  },
];

export const adminSubs: Menu[] = [
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/directions-neo' },
    activeName: 'zones',
    label: 'Напрямки',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/organisms-neo' },
    activeName: 'organisms-neo',
    label: 'Організми',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/users-neo' },
    activeName: 'users-neo',
    label: 'Користувачі',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/messenger-neo' },
    activeName: 'messenger-neo',
    label: 'Месенджери',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/aor-neo' },
    activeName: 'aor-neo',
    label: 'Смуги',
  },
  {
    type: 'item',
    link: { type: 'internal', path: '/admin/system-settings-neo' },
    activeName: 'system-settings-neo',
    label: 'Налаштування системи',
  },
  { type: 'separator' },
  {
    type: 'group',
    label: 'Бази',
    subs: adminDatabaseSubs,
  },
  { type: 'separator' },
  {
    type: 'group',
    label: 'ШІ',
    subs: aiAgentAdminSubs,
  },
  { type: 'separator' },
  {
    type: 'group',
    label: 'Імпорт',
    subs: [
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
    ],
  },
];
