import {
  Autocomplete,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Switch,
  TextField,
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { useUserLookupDebug } from './use-user-lookup-debug';
import { useUserManagementScope, userRoleOptions } from './user-management-scope';
import { UserIdentity } from './UserIdentity';
import { UserPasswordAdornment } from './UserPasswordAdornment';

import { Login } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { updateLogin } from '../../services/api/logins';
import { ApiSenders } from './ApiSenders';
import { MessengerProfileSelect } from './MessengerProfileSelect';

import { debugLog, renderLookupAutocompleteOption } from './user-display';
import {
  asStringArray,
  buildEditUserErrors,
  clearAuthenticationGroupServerError,
  clearAuthenticationServerErrors,
  formatServerValidationFallback,
  hasFormErrors,
  parseServerFieldErrors,
  toUpdateLoginReq,
  visibleFieldError,
} from './user-form-helpers';
import {
  EditUserForm,
  LookupAutocompleteOption,
  UserField,
  UserFieldState,
  UserLookups,
  UserServerErrors,
} from './user-types';
export function EditUserDialog(props: {
  open: boolean;
  login: Login | null;
  onClose: () => void;
  onUserUpdated: (login: Login) => void;
  lookups: UserLookups;
  disableRestoreFocus?: boolean;
  onExited?: () => void;
}) {
  const { open, login, onClose, onUserUpdated, lookups, disableRestoreFocus = false } = props;
  const organism = useUserManagementScope();
  const roleOptions = userRoleOptions(organism);
  const [form, setForm] = useState<EditUserForm | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState<UserFieldState>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<UserServerErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const focusInvalidField = useRef(false);

  const zonesReady = Boolean(organism) || lookups.zonesStatus === 'success';
  const zonesLoading = lookups.zonesStatus === 'loading';
  const organismsReady = lookups.organismsStatus === 'success';
  const organismsLoading = lookups.organismsStatus === 'loading';
  const validationErrors = form && login ? buildEditUserErrors(form, login, Boolean(organism)) : {};
  const canSubmit =
    (zonesReady || Boolean(form?.sigintZoneId)) &&
    (organismsReady || Boolean(form?.organismId)) &&
    !isSubmitting &&
    Boolean(form) &&
    !hasFormErrors(validationErrors);
  const deltaLoginRequired = Boolean(
    form &&
    login &&
    !form.deleted &&
    !form.passwordAuthEnabled &&
    (form.deltaLogin.trim() !== (login.deltaLogin ?? '').trim() ||
      form.passwordAuthEnabled !== login.passwordAuthEnabled ||
      form.password.length > 0 ||
      (login.deleted && !form.deleted)),
  );
  const passwordRequired = Boolean(
    form && login && !login.passwordAuthEnabled && form.passwordAuthEnabled && !form.hasPassword,
  );

  const zoneAutocompleteOptions: LookupAutocompleteOption[] = lookups.zones.map(
    ([zoneId, zone]) => ({
      id: zoneId,
      label: zone.name || `ID ${zoneId}`,
    }),
  );

  const organismAutocompleteOptions: LookupAutocompleteOption[] = lookups.organisms.map(
    (organism) => ({
      id: organism.id,
      label: organism.name || `ID ${organism.id}`,
    }),
  );
  const selectedOrganismEnabled =
    lookups.organisms.find((organism) => organism.id === form?.organismId)?.enabled ??
    (form?.organismId === login?.organismId ? login?.organismEnabled : undefined);

  useEffect(() => {
    if (!open || !login) {
      setForm(null);
      setTouched({});
      setSubmitAttempted(false);
      setServerErrors({});
      setSubmitError(null);
      setIsSubmitting(false);
      return;
    }

    setForm({
      id: login.id,
      login: login.login,
      password: '',
      roles: login.roles ?? [],
      sigintZoneId: login.sigintZoneId ?? null,
      organismId: login.organismId ?? null,
      deltaLogin: login.deltaLogin ?? '',
      deleted: login.deleted,
      signalProfileId: login.signalProfileId,
      description: login.description ?? '',
      passwordAuthEnabled: login.passwordAuthEnabled,
      hasPassword: login.hasPassword,
    });
    setTouched({});
    setSubmitAttempted(false);
    setServerErrors({});
    setShowPassword(false);
    setSubmitError(null);
    setIsSubmitting(false);
  }, [open, login]);

  useUserLookupDebug('edit', open, lookups, form);

  useEffect(() => {
    if (!focusInvalidField.current) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    focusInvalidField.current = false;
  }, [submitAttempted, validationErrors]);

  function touch(field: UserField) {
    setTouched((current) => (current[field] ? current : { ...current, [field]: true }));
  }

  function changeServerField(field: UserField) {
    setServerErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  }

  function fieldError(field: UserField) {
    return visibleFieldError(field, validationErrors, serverErrors, touched, submitAttempted);
  }

  function handleClose() {
    if (isSubmitting) return;
    onClose();
  }

  async function handleSave() {
    if (
      !form ||
      isSubmitting ||
      !(zonesReady || Boolean(form.sigintZoneId)) ||
      !(organismsReady || Boolean(form.organismId))
    ) {
      return;
    }
    const nextErrors = buildEditUserErrors(form, login!, Boolean(organism));
    setSubmitAttempted(true);
    if (hasFormErrors(nextErrors)) {
      focusInvalidField.current = true;
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const updated = await updateLogin(toUpdateLoginReq(form, login!));
      onUserUpdated(updated);
      onClose();
    } catch (err) {
      const parsedErrors = parseServerFieldErrors(err);
      setServerErrors(parsedErrors.fields);
      setSubmitError(formatServerValidationFallback(err, parsedErrors));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth={false}
      fullWidth
      disableRestoreFocus={disableRestoreFocus}
      slotProps={{
        transition: { onExited: props.onExited },
        paper: {
          sx: { width: 'calc(100% - 32px)', maxWidth: '768px', m: 2 },
          component: 'form',
          ...{ noValidate: true },
          onSubmit: (event) => {
            event.preventDefault();
            void handleSave();
          },
        },
      }}
    >
      <DialogTitle>Редагувати користувача</DialogTitle>
      <DialogContent className="space-y-3 py-3">
        {lookups.zonesError ? (
          <PowerAlert severity="error">{`Не вдалося завантажити зони: ${lookups.zonesError}`}</PowerAlert>
        ) : null}
        {lookups.organismsError ? (
          <PowerAlert severity="error">{`Не вдалося завантажити організми: ${lookups.organismsError}`}</PowerAlert>
        ) : null}
        {submitError ? <PowerAlert severity="error">{submitError}</PowerAlert> : null}

        {form ? (
          <div ref={formRef} className="grid gap-3 md:grid-cols-2">
            <UserIdentity id={form.id} />

            <TextField
              label="Логін"
              value={form.login}
              onChange={(event) => {
                setForm((prev) => (prev ? { ...prev, login: event.target.value } : prev));
                changeServerField('login');
              }}
              onBlur={() => touch('login')}
              required
              fullWidth
              error={Boolean(fieldError('login'))}
              helperText={fieldError('login')}
              disabled={isSubmitting}
              autoFocus
            />

            <TextField
              label="Delta логін"
              value={form.deltaLogin}
              onChange={(event) => {
                setForm((prev) => (prev ? { ...prev, deltaLogin: event.target.value } : prev));
                setServerErrors((current) =>
                  clearAuthenticationGroupServerError(current, 'deltaLogin'),
                );
              }}
              onBlur={() => touch('deltaLogin')}
              required={deltaLoginRequired}
              error={Boolean(fieldError('deltaLogin'))}
              helperText={
                fieldError('deltaLogin') || (organism ? 'Прив’язками Delta керує Admin' : undefined)
              }
              fullWidth
              disabled={isSubmitting}
              slotProps={{ input: { readOnly: Boolean(organism) } }}
            />

            <div className="flex items-center md:col-span-2">
              <FormControlLabel
                control={
                  <Switch
                    checked={form.passwordAuthEnabled}
                    onChange={(event) => {
                      setForm((prev) => {
                        if (!prev) return prev;
                        return {
                          ...prev,
                          passwordAuthEnabled: event.target.checked,
                          password: event.target.checked ? prev.password : '',
                        };
                      });
                      setShowPassword(false);
                      setServerErrors(clearAuthenticationServerErrors);
                    }}
                    disabled={isSubmitting}
                    inputProps={
                      serverErrors.passwordAuthEnabled
                        ? {
                            'aria-describedby': `edit-password-authentication-error-${form.id}`,
                          }
                        : undefined
                    }
                  />
                }
                label="Вхід за паролем"
              />
              {serverErrors.passwordAuthEnabled ? (
                <p
                  id={`edit-password-authentication-error-${form.id}`}
                  className="text-xs text-error"
                  role="alert"
                >
                  {serverErrors.passwordAuthEnabled}
                </p>
              ) : null}
            </div>

            {form.passwordAuthEnabled ? (
              <TextField
                label="Новий пароль"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={form.password}
                onChange={(event) => {
                  setForm((prev) => (prev ? { ...prev, password: event.target.value } : prev));
                  setServerErrors((current) =>
                    clearAuthenticationGroupServerError(current, 'password'),
                  );
                }}
                onBlur={() => touch('password')}
                required={passwordRequired}
                helperText={fieldError('password') || 'Залиште порожнім, щоб не змінювати'}
                error={Boolean(fieldError('password'))}
                fullWidth
                disabled={isSubmitting || !form.passwordAuthEnabled}
                className="md:col-span-2"
                InputProps={{
                  endAdornment: (
                    <UserPasswordAdornment
                      visible={showPassword}
                      disabled={isSubmitting}
                      toggle={() => setShowPassword((prev) => !prev)}
                    />
                  ),
                }}
              />
            ) : null}

            {!organism ? (
              <Autocomplete
                options={organismAutocompleteOptions}
                value={
                  organismAutocompleteOptions.find((opt) => opt.id === form.organismId) || null
                }
                onChange={(_, newValue) => {
                  const value = newValue?.id ?? null;
                  debugLog('edit:organism change', { newValue, parsed: value });
                  setForm((prev) => (prev ? { ...prev, organismId: value } : prev));
                  changeServerField('organism');
                }}
                loading={organismsLoading}
                disabled={isSubmitting}
                isOptionEqualToValue={(option, value) => option.id === value.id}
                getOptionLabel={(option) => option.label}
                className="md:col-span-2"
                renderOption={(props, option) =>
                  renderLookupAutocompleteOption(props, option, 'edit-organism')
                }
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Організм"
                    required
                    onBlur={() => touch('organism')}
                    error={Boolean(fieldError('organism'))}
                    helperText={fieldError('organism')}
                  />
                )}
              />
            ) : null}

            <TextField
              select
              label="Ролі"
              value={form.roles}
              onChange={(event) => {
                setForm((prev) =>
                  prev ? { ...prev, roles: asStringArray(event.target.value) } : prev,
                );
                changeServerField('roles');
              }}
              onBlur={() => touch('roles')}
              required
              fullWidth
              SelectProps={{
                multiple: true,
                renderValue: (selected) => (selected as string[]).join(', ') || '—',
              }}
              error={Boolean(fieldError('roles'))}
              helperText={fieldError('roles')}
              disabled={isSubmitting}
            >
              {roleOptions.map((role) => (
                <MenuItem key={role} value={role}>
                  {role}
                </MenuItem>
              ))}
            </TextField>

            {!organism ? (
              <Autocomplete
                options={zoneAutocompleteOptions}
                value={zoneAutocompleteOptions.find((opt) => opt.id === form.sigintZoneId) || null}
                onChange={(_, newValue) => {
                  const value = newValue?.id ?? null;
                  debugLog('edit:zone change', { newValue, parsed: value });
                  setForm((prev) => (prev ? { ...prev, sigintZoneId: value } : prev));
                  changeServerField('zone');
                }}
                loading={zonesLoading}
                disabled={isSubmitting}
                isOptionEqualToValue={(option, value) => option.id === value.id}
                getOptionLabel={(option) => option.label}
                renderOption={(props, option) =>
                  renderLookupAutocompleteOption(props, option, 'edit-zone')
                }
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Зона"
                    required
                    onBlur={() => touch('zone')}
                    error={Boolean(fieldError('zone'))}
                    helperText={fieldError('zone')}
                  />
                )}
              />
            ) : null}

            {!organism ? (
              <MessengerProfileSelect
                value={form.signalProfileId}
                onChange={(signalProfileId) =>
                  setForm((prev) => (prev ? { ...prev, signalProfileId } : prev))
                }
                disabled={isSubmitting}
              />
            ) : null}

            <div className="md:col-span-2">
              <FormControlLabel
                control={
                  <Switch
                    checked={!form.deleted}
                    onChange={(event) => {
                      setForm((prev) =>
                        prev ? { ...prev, deleted: !event.target.checked } : prev,
                      );
                    }}
                    disabled={isSubmitting}
                    inputProps={{ 'aria-describedby': `active-helper-${form.id}` }}
                  />
                }
                label="Активний"
              />
              <p id={`active-helper-${form.id}`} className="text-xs text-muted-foreground">
                Вимкнення блокує доступ після збереження.
              </p>
              {selectedOrganismEnabled === false ? (
                <PowerAlert className="mt-2" severity="warning">
                  Організм деактивовано, тому доступ користувача заблоковано незалежно від стану
                  облікового запису.
                </PowerAlert>
              ) : null}
            </div>

            <TextField
              label="Нотатка"
              value={form.description}
              onChange={(event) => {
                setForm((prev) => (prev ? { ...prev, description: event.target.value } : prev));
              }}
              fullWidth
              multiline
              minRows={2}
              disabled={isSubmitting}
              className="md:col-span-2"
            />
            {login?.roles.includes('Api') ? (
              <ApiSenders apiId={login.id} disabled={isSubmitting} />
            ) : null}
          </div>
        ) : null}
      </DialogContent>
      <DialogActions>
        <PowerButton type="button" onClick={handleClose} disabled={isSubmitting}>
          Скасувати
        </PowerButton>
        <PowerButton variant="contained" type="submit" disabled={!canSubmit}>
          Зберегти
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}
