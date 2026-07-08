import type { TagAdmin } from '../../../../../Bindings';

export type LoadStatus = 'idle' | 'loading' | 'success' | 'error';

// `enabled` doubles as our soft-delete flag — the "Архів" view surfaces disabled tags so
// admins can still find and re-enable them, with no distinct deleted state and no
// client-only (localStorage) tracking.
export type TagsView = 'active' | 'archived';

export type TagFormState = {
  label: string;
  extra: boolean;
  ord: string;
  enabled: boolean;
  isPalitra: boolean;
};

export const emptyTagForm: TagFormState = {
  label: '',
  extra: false,
  ord: '',
  enabled: true,
  isPalitra: false,
};

export function formFromTag(tag: TagAdmin): TagFormState {
  return {
    label: tag.label,
    extra: Boolean(tag.extra),
    ord: tag.ord == null ? '' : String(tag.ord),
    enabled: tag.enabled,
    isPalitra: tag.isPalitra,
  };
}

export function parseOrdValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

export function formatYesNo(value: boolean | null | undefined): string {
  return value ? 'так' : 'ні';
}
