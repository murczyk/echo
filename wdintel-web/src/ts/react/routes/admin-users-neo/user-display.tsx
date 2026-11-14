import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { Box, IconButton, Tooltip } from '@mui/material';
import type { HTMLAttributes, Key } from 'react';
import { useState } from 'react';

import { Login } from '../../../../Bindings';
import { copyTextToClipboard } from '../../../copy-to-clipboard';
import { FULL_HEIGHT_LOADING_ROW_COUNT } from '../../components/mui-customized/table/custom-styles';

import { asStringArray } from './user-form-helpers';
import { LEGACY_STATUS_FILTER_VALUES, LookupAutocompleteOption, StatusInfo } from './user-types';
export function renderLookupAutocompleteOption(
  props: HTMLAttributes<HTMLLIElement> & { key: Key },
  option: LookupAutocompleteOption,
  prefix: string,
) {
  const { key: _unusedKey, ...optionProps } = props;
  return (
    <Box component="li" {...optionProps} key={`${prefix}-${option.id}`}>
      {option.label}
    </Box>
  );
}

export function buildUserLoadingRows(): Login[] {
  return Array.from({ length: FULL_HEIGHT_LOADING_ROW_COUNT }, (_, index) => ({
    id: `loading-${index}`,
    login: `loading-${index}`,
    roles: [],
    deleted: false,
    deactivationReason: null,
    signalProfileId: null,
    description: null,
    passwordAuthEnabled: true,
    hasPassword: false,
    totpEnabled: false,
    organismEnabled: true,
    sigintZoneId: null,
    organismName: null,
    organismId: null,
    sigintZoneName: null,
    deltaLogin: null,
    createdAt: 0,
    lastActiveAt: null,
  }));
}

export const DEBUG_USERS_NEO =
  typeof window !== 'undefined' && window.localStorage.getItem('debugUsersNeo') === '1';

export function debugLog(message: string, details?: unknown) {
  if (!DEBUG_USERS_NEO) return;
  if (details === undefined) {
    console.info('[users-neo]', message);
    return;
  }
  console.info('[users-neo]', message, details);
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

export function formatDate(value: number | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('uk-UA');
}

export function formatDateTime(value: number | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('uk-UA');
}

export function formatOptionalLabel(value: string | null | undefined): string {
  if (!value || !value.trim()) return '—';
  return value;
}

export function formatUuidShort(uuid: string): string {
  if (uuid.length <= 13) return uuid;
  return `${uuid.slice(0, 5)}...${uuid.slice(-5)}`;
}

export function CopyUuidButton({ uuid, className }: { uuid: string; className?: string }) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const copyLabel =
    copyStatus === 'copied'
      ? 'UUID скопійовано'
      : copyStatus === 'error'
        ? 'Не вдалося скопіювати UUID'
        : 'Копіювати UUID';

  return (
    <Tooltip title={copyLabel}>
      <IconButton
        className={className}
        size="small"
        aria-label={copyLabel}
        onClick={(event) => {
          event.stopPropagation();
          event.currentTarget.blur();
          void copyTextToClipboard(uuid)
            .then(() => setCopyStatus('copied'))
            .catch(() => setCopyStatus('error'));
        }}
        onBlur={() => setCopyStatus('idle')}
        onMouseLeave={() => setCopyStatus('idle')}
      >
        <ContentCopyIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

export function getStatusInfo(login: Login): StatusInfo {
  if (login.deleted) {
    if (login.deactivationReason === 'Admin') {
      return {
        label: 'Деактивовано адміністратором',
        colorClass: 'text-red-600',
        details: login.organismEnabled === false ? ['Організм деактивовано'] : undefined,
      };
    }
    if (login.deactivationReason === 'Inactive') {
      return {
        label: 'Деактивовано через неактивність',
        colorClass: 'text-yellow-600',
        details: [
          ...(login.lastActiveAt ? [`Останній: ${formatDateTime(login.lastActiveAt)}`] : []),
          ...(login.organismEnabled === false ? ['Організм деактивовано'] : []),
        ],
      };
    }
    return {
      label: 'Деактивовано',
      colorClass: 'text-gray-600',
      details: login.organismEnabled === false ? ['Організм деактивовано'] : undefined,
    };
  }

  if (login.organismEnabled === false) {
    return { label: 'Організм деактивовано', colorClass: 'text-red-600' };
  }

  return { label: 'Активний', colorClass: 'text-green-600' };
}

export function matchesStatusFilter(login: Login, filterValue: unknown): boolean {
  const selected = asStringArray(filterValue).map(
    (value) => LEGACY_STATUS_FILTER_VALUES[value] ?? value,
  );
  return selected.length === 0 || selected.includes(getStatusInfo(login).label);
}
