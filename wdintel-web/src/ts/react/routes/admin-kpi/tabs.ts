export enum KpiTab {
  Accounts = 'accounts',
  Activity = 'activity',
  Speed = 'speed',
  Quality = 'quality',
}

export const kpiTabs = {
  [KpiTab.Accounts]: 'База користувачів',
  [KpiTab.Activity]: 'Активність',
  [KpiTab.Speed]: 'Чого затримуються (швидкість)',
  [KpiTab.Quality]: 'Технічна якість',
} satisfies Record<KpiTab, string>;
