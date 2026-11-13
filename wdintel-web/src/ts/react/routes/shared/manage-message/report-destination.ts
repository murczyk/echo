const STORAGE_KEY = 'echo_lastReportDestination';

export function readReportDestination(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberReportDestination(masterKey: string): void {
  try {
    if (masterKey) localStorage.setItem(STORAGE_KEY, masterKey);
    else localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Failed to save report destination', error);
  }
}
