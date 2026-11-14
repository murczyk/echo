import { CreateLoginReq, Login } from '../../../../Bindings';
import { type UpdateLoginPatch } from '../../services/api/logins';

import { formatErrorMessage } from './user-display';
import {
  AddUserErrors,
  AddUserForm,
  EditUserErrors,
  EditUserForm,
  ParsedServerFieldErrors,
  UserField,
  UserFieldState,
  UserServerErrors,
} from './user-types';
export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function buildAddUserErrors(form: AddUserForm, inheritZone = false): AddUserErrors {
  const errors: AddUserErrors = {};

  if (!form.login.trim()) {
    errors.login = 'Логін не може бути пустим';
  }

  if (form.passwordAuthEnabled && !form.password.trim()) {
    errors.password = 'Пароль не може бути пустим або складатися лише з пробілів';
  }

  if (!form.passwordAuthEnabled && !form.deltaLogin.trim()) {
    errors.deltaLogin = 'Вкажіть Delta логін або увімкніть вхід за паролем';
  }

  if (form.roles.length === 0) {
    errors.roles = 'Виберіть хочаб 1 роль';
  }

  if (!inheritZone && !form.sigintZoneId) {
    errors.zone = 'Виберіть зону';
  }

  if (!form.organismId) {
    errors.organism = 'Виберіть організм';
  }

  return errors;
}

export function hasFormErrors(errors: AddUserErrors | EditUserErrors): boolean {
  return Object.values(errors).some(Boolean);
}

export function visibleFieldError(
  field: UserField,
  validationErrors: AddUserErrors | EditUserErrors,
  serverErrors: AddUserErrors | EditUserErrors,
  touched: UserFieldState,
  submitAttempted: boolean,
): string | undefined {
  if (serverErrors[field]) return serverErrors[field];
  return submitAttempted || touched[field] ? validationErrors[field] : undefined;
}

export function parseServerFieldErrors(error: unknown): ParsedServerFieldErrors {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  if (!message)
    return { fields: {}, fallbackMessages: [], hasDiscardedEntries: true, isJson: false };

  try {
    const value = JSON.parse(message) as Record<string, unknown>;
    const wrappedFields =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value.fields ?? value.fieldErrors ?? value.field_errors ?? value.errors)
        : undefined;
    const entries: unknown[] = Array.isArray(value)
      ? value
      : wrappedFields && typeof wrappedFields === 'object' && !Array.isArray(wrappedFields)
        ? Object.entries(wrappedFields)
        : [];
    if (entries.length === 0) {
      return { fields: {}, fallbackMessages: [], hasDiscardedEntries: true, isJson: true };
    }

    const fields: UserServerErrors = {};
    const fallbackMessages: string[] = [];
    let hasDiscardedEntries = false;
    const fieldByBackendKey: Record<string, keyof UserServerErrors> = {
      login: 'login',
      deltaLogin: 'deltaLogin',
      delta_login: 'deltaLogin',
      password: 'password',
      roles: 'roles',
      zone: 'zone',
      sigintZoneId: 'zone',
      sigint_zone_id: 'zone',
      organism: 'organism',
      organismId: 'organism',
      organism_id: 'organism',
      passwordAuthEnabled: 'passwordAuthEnabled',
      password_auth_enabled: 'passwordAuthEnabled',
    };
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        hasDiscardedEntries = true;
        continue;
      }
      const [key, value] = entry;
      if (typeof key !== 'string' || !key.trim() || typeof value !== 'string' || !value.trim()) {
        hasDiscardedEntries = true;
        continue;
      }
      const field = fieldByBackendKey[key];
      if (field) {
        fields[field] ??= value;
      } else {
        fallbackMessages.push(`${key}: ${value}`);
      }
    }
    return { fields, fallbackMessages, hasDiscardedEntries, isJson: true };
  } catch (_) {
    return { fields: {}, fallbackMessages: [], hasDiscardedEntries: true, isJson: false };
  }
}

export function formatServerValidationFallback(
  error: unknown,
  parsedErrors: ParsedServerFieldErrors,
): string {
  if (!parsedErrors.isJson) {
    const message = formatErrorMessage(error);
    return /^[\[{]/.test(message.trim()) ? 'Не вдалося зберегти користувача' : message;
  }
  const messages = [...parsedErrors.fallbackMessages];
  if (
    parsedErrors.hasDiscardedEntries ||
    (messages.length === 0 && Object.keys(parsedErrors.fields).length === 0)
  ) {
    messages.push('Не вдалося зберегти користувача');
  }
  return messages.join('\n');
}

export function clearAuthenticationGroupServerError(
  current: UserServerErrors,
  field: 'deltaLogin' | 'password',
): UserServerErrors {
  if (!current[field] && !current.passwordAuthEnabled) return current;
  return { ...current, [field]: undefined, passwordAuthEnabled: undefined };
}

export function clearAuthenticationServerErrors(current: UserServerErrors): UserServerErrors {
  if (!current.password && !current.deltaLogin && !current.passwordAuthEnabled) return current;
  return {
    ...current,
    password: undefined,
    deltaLogin: undefined,
    passwordAuthEnabled: undefined,
  };
}

export function toCreateLoginReq(form: AddUserForm): CreateLoginReq {
  if (!form.organismId) throw new Error('Виберіть організм');

  return {
    login: form.login.trim(),
    password: form.passwordAuthEnabled ? form.password : null,
    roles: form.roles,
    sigintZoneId: form.sigintZoneId,
    organismId: form.organismId,
    signalProfileId: form.signalProfileId,
    description: form.description.trim() || null,
    deltaLogin: form.deltaLogin.trim() || null,
    passwordAuthEnabled: form.passwordAuthEnabled,
  };
}

export function buildEditUserErrors(
  form: EditUserForm,
  original: Login,
  inheritZone = false,
): EditUserErrors {
  const errors: EditUserErrors = {};

  if (!form.login.trim()) {
    errors.login = 'Логін не може бути пустим';
  }

  if (form.roles.length === 0) {
    errors.roles = 'Виберіть хочаб 1 роль';
  }

  if (!inheritZone && !form.sigintZoneId) {
    errors.zone = 'Виберіть зону';
  }

  if (!form.organismId) {
    errors.organism = 'Виберіть організм';
  }

  const passwordWasSupplied = form.password.length > 0;
  const hasValidReplacementPassword = passwordWasSupplied && Boolean(form.password.trim());
  if (passwordWasSupplied && !hasValidReplacementPassword) {
    errors.password = 'Пароль не може бути пустим або складатися лише з пробілів';
  }

  if (
    !original.passwordAuthEnabled &&
    form.passwordAuthEnabled &&
    !form.hasPassword &&
    !passwordWasSupplied &&
    !hasValidReplacementPassword
  ) {
    errors.password = 'Для входу за паролем вкажіть пароль';
  }

  const deltaChanged = form.deltaLogin.trim() !== (original.deltaLogin ?? '').trim();
  const authenticationChanged =
    deltaChanged ||
    form.passwordAuthEnabled !== original.passwordAuthEnabled ||
    passwordWasSupplied;
  const reactivating = original.deleted && !form.deleted;
  if (
    (authenticationChanged || reactivating) &&
    !form.deleted &&
    !(
      form.deltaLogin.trim() ||
      (form.passwordAuthEnabled && (form.hasPassword || hasValidReplacementPassword))
    )
  ) {
    errors.deltaLogin = 'Для активного користувача налаштуйте вхід за паролем або Delta';
  }

  return errors;
}

export function toClearTotpReq(login: Login): UpdateLoginPatch {
  if (!login.organismId) throw new Error('Виберіть організм');

  return {
    id: login.id,
    login: login.login,
    organismId: login.organismId,
    clearTotp: true,
  };
}

export function toUpdateLoginReq(form: EditUserForm, original: Login): UpdateLoginPatch {
  if (!form.organismId) throw new Error('Виберіть організм');

  const trimmedDelta = form.deltaLogin.trim();

  return {
    id: form.id,
    login: form.login.trim(),
    roles: form.roles,
    sigintZoneId: form.sigintZoneId,
    organismId: form.organismId,
    ...(form.deleted === original.deleted ? {} : { deleted: form.deleted }),
    password: form.password || null,
    ...(trimmedDelta === (original.deltaLogin ?? '').trim()
      ? {}
      : { deltaLogin: trimmedDelta || null }),
    ...(form.signalProfileId === original.signalProfileId
      ? {}
      : { signalProfileId: form.signalProfileId }),
    description: form.description.trim() || null,
    ...(form.passwordAuthEnabled === original.passwordAuthEnabled
      ? {}
      : { passwordAuthEnabled: form.passwordAuthEnabled }),
  };
}
