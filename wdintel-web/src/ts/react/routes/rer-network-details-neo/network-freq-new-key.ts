const NETWORK_FREQ_NEW_KEY_RE = /^[A-Z0-9]{4,64}$/;

export function validateNetworkFreqNewKey(key: string): string | null {
  const trimmedKey = key.trim();
  if (trimmedKey === '') {
    return 'Потрібно вказати ключ';
  }

  return NETWORK_FREQ_NEW_KEY_RE.test(trimmedKey) ? null : 'Ключ має містити 4-64 символи A-Z або 0-9';
}
