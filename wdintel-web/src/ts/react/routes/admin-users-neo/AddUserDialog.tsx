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
import { UserPasswordAdornment } from './UserPasswordAdornment';

import { Login } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { createLogin } from '../../services/api/logins';
import { MessengerProfileSelect } from './MessengerProfileSelect';

import { debugLog, renderLookupAutocompleteOption } from './user-display';
import {
  asStringArray,
  buildAddUserErrors,
  clearAuthenticationGroupServerError,
  clearAuthenticationServerErrors,
  formatServerValidationFallback,
  hasFormErrors,
  parseServerFieldErrors,
  toCreateLoginReq,
  visibleFieldError,
} from './user-form-helpers';
import {
  AddUserForm,
  EMPTY_ADD_FORM,
  LookupAutocompleteOption,
  UserField,
  UserFieldState,
  UserLookups,
  UserServerErrors,
} from './user-types';
export function AddUserDialog(props: {
  open: boolean;
  onClose: () => void;
  onUserCreated: (login: Login) => void;
  lookups: UserLookups;
  initialOrganismId?: number;
}) {
  const { open, onClose, onUserCreated, lookups } = props;
  const organism = useUserManagementScope();
  const roleOptions = userRoleOptions(organism);
  const initialForm: AddUserForm = organism
    ? {
        ...EMPTY_ADD_FORM,
        organismId: organism.id,
        passwordAuthEnabled: true,
        roles: roleOptions.includes('Basic')
          ? ['Basic']
          : roleOptions.filter((role) => role !== 'OrganismAdmin').slice(0, 1),
      }
    : { ...EMPTY_ADD_FORM, organismId: props.initialOrganismId ?? null };
  const [form, setForm] = useState<AddUserForm>(initialForm);
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
  const validationErrors = buildAddUserErrors(form, Boolean(organism));
  const canSubmit =
    zonesReady && organismsReady && !isSubmitting && !hasFormErrors(validationErrors);

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

  useEffect(() => {
    if (!open || lookups.zones.length !== 1) return;
    const [zoneId] = lookups.zones[0];
    setForm((prev) => (prev.sigintZoneId === null ? { ...prev, sigintZoneId: zoneId } : prev));
  }, [open, lookups.zones]);

  useEffect(() => {
    if (!open || lookups.organisms.length !== 1) return;
    const [organism] = lookups.organisms;
    setForm((prev) => (prev.organismId === null ? { ...prev, organismId: organism.id } : prev));
  }, [open, lookups.organisms]);

  useUserLookupDebug('add', open, lookups, form);

  useEffect(() => {
    if (open) return;
    setForm(initialForm);
    setShowPassword(false);
    setTouched({});
    setSubmitAttempted(false);
    setServerErrors({});
    setSubmitError(null);
    setIsSubmitting(false);
  }, [open]);

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

  async function handleCreateUser() {
    if (isSubmitting || !zonesReady || !organismsReady) return;
    const nextErrors = buildAddUserErrors(form, Boolean(organism));
    setSubmitAttempted(true);
    if (hasFormErrors(nextErrors)) {
      focusInvalidField.current = true;
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const payload = toCreateLoginReq(form);
      const created = await createLogin(payload);
      onUserCreated(created);
      setForm(initialForm);
      setTouched({});
      setSubmitAttempted(false);
      setServerErrors({});
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
      slotProps={{
        paper: {
          sx: { width: 'calc(100% - 32px)', maxWidth: '768px', m: 2 },
          component: 'form',
          ...{ noValidate: true },
          onSubmit: (event) => {
            event.preventDefault();
            void handleCreateUser();
          },
        },
      }}
    >
      <DialogTitle>Додати користувача</DialogTitle>
      <DialogContent className="space-y-3 py-3">
        {lookups.zonesError ? (
          <PowerAlert severity="error">{`Не вдалося завантажити зони: ${lookups.zonesError}`}</PowerAlert>
        ) : null}
        {lookups.organismsError ? (
          <PowerAlert severity="error">{`Не вдалося завантажити організми: ${lookups.organismsError}`}</PowerAlert>
        ) : null}
        {submitError ? <PowerAlert severity="error">{submitError}</PowerAlert> : null}

        <div ref={formRef} className="grid gap-3 md:grid-cols-2">
          {!organism ? (
            <TextField
              label="Delta логін"
              value={form.deltaLogin}
              onChange={(event) => {
                const deltaLogin = event.target.value;
                setForm((prev) => ({ ...prev, deltaLogin, login: deltaLogin }));
                setServerErrors((current) => ({
                  ...clearAuthenticationGroupServerError(current, 'deltaLogin'),
                  login: undefined,
                }));
              }}
              onBlur={() => touch('deltaLogin')}
              required={!form.passwordAuthEnabled}
              error={Boolean(fieldError('deltaLogin'))}
              helperText={fieldError('deltaLogin')}
              fullWidth
              disabled={isSubmitting}
              autoFocus
            />
          ) : null}

          <TextField
            autoFocus={Boolean(organism)}
            label="Логін"
            value={form.login}
            onChange={(event) => {
              setForm((prev) => ({ ...prev, login: event.target.value }));
              changeServerField('login');
            }}
            onBlur={() => touch('login')}
            required
            error={Boolean(fieldError('login'))}
            helperText={fieldError('login')}
            fullWidth
            disabled={isSubmitting}
          />

          {!organism ? (
            <div className="md:col-span-2">
              <FormControlLabel
                control={
                  <Switch
                    checked={form.passwordAuthEnabled}
                    onChange={(event) => {
                      setForm((prev) => ({
                        ...prev,
                        passwordAuthEnabled: event.target.checked,
                        password: event.target.checked ? prev.password : '',
                      }));
                      setShowPassword(false);
                      setServerErrors(clearAuthenticationServerErrors);
                    }}
                    disabled={isSubmitting}
                    inputProps={
                      serverErrors.passwordAuthEnabled
                        ? { 'aria-describedby': 'add-password-authentication-error' }
                        : undefined
                    }
                  />
                }
                label="Вхід за паролем"
              />
              {serverErrors.passwordAuthEnabled ? (
                <p
                  id="add-password-authentication-error"
                  className="text-xs text-error"
                  role="alert"
                >
                  {serverErrors.passwordAuthEnabled}
                </p>
              ) : null}
            </div>
          ) : null}

          {form.passwordAuthEnabled ? (
            <TextField
              label="Пароль"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              value={form.password}
              onChange={(event) => {
                setForm((prev) => ({ ...prev, password: event.target.value }));
                setServerErrors((current) =>
                  clearAuthenticationGroupServerError(current, 'password'),
                );
              }}
              onBlur={() => touch('password')}
              required
              error={Boolean(fieldError('password'))}
              helperText={fieldError('password')}
              fullWidth
              disabled={isSubmitting}
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
              value={organismAutocompleteOptions.find((opt) => opt.id === form.organismId) || null}
              onChange={(_, newValue) => {
                const value = newValue?.id ?? null;
                debugLog('add:organism change', { newValue, parsed: value });
                setForm((prev) => ({ ...prev, organismId: value }));
                changeServerField('organism');
              }}
              loading={organismsLoading}
              disabled={isSubmitting}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              getOptionLabel={(option) => option.label}
              className="md:col-span-2"
              renderOption={(props, option) =>
                renderLookupAutocompleteOption(props, option, 'add-organism')
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
              setForm((prev) => ({ ...prev, roles: asStringArray(event.target.value) }));
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
                debugLog('add:zone change', { newValue, parsed: value });
                setForm((prev) => ({ ...prev, sigintZoneId: value }));
                changeServerField('zone');
              }}
              loading={zonesLoading}
              disabled={isSubmitting}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              getOptionLabel={(option) => option.label}
              renderOption={(props, option) =>
                renderLookupAutocompleteOption(props, option, 'add-zone')
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
              onChange={(signalProfileId) => setForm((prev) => ({ ...prev, signalProfileId }))}
              disabled={isSubmitting}
            />
          ) : null}
          <TextField
            label="Нотатка"
            value={form.description}
            onChange={(event) => {
              setForm((prev) => ({ ...prev, description: event.target.value }));
            }}
            fullWidth
            multiline
            minRows={2}
            disabled={isSubmitting}
            className="md:col-span-2"
          />
        </div>
      </DialogContent>
      <DialogActions>
        <PowerButton type="button" onClick={handleClose} disabled={isSubmitting}>
          Скасувати
        </PowerButton>
        <PowerButton variant="contained" type="submit" disabled={!canSubmit}>
          Додати
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}
