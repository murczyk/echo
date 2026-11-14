import {
  Autocomplete,
  Box,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { useOrganismManagement } from '../admin-organisms-neo/management-context';

import { Organism } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { SectionEmptyState } from '../../components/SectionEmptyState';
import { SectionErrorState } from '../../components/SectionErrorState';
import { navigateWithinSpa } from '../../utils/browser';
import {
  asNumberArray,
  asStringArray,
  formatAorLabel,
  formatGroupLabel,
  OrganismFormFieldsProps,
  ROLE_OPTIONS,
} from './use-organism-editor.shared';
export function OrganismFormFields(props: OrganismFormFieldsProps) {
  const { globalAdmin } = useOrganismManagement();
  const aorOptions = props.aors.map((aor) => (
    <MenuItem key={aor.id} value={aor.id}>
      {aor.name}
    </MenuItem>
  ));
  const groupOptions = props.availableGroups.map((group) => (
    <MenuItem key={group.masterKey} value={group.masterKey}>
      {formatGroupLabel(group, group.masterKey)}
    </MenuItem>
  ));

  const parentValue: Pick<Organism, 'id' | 'name'> | null =
    props.organisms.find((organism) => organism.id === props.form.parentId) ??
    (props.form.parentId === null
      ? null
      : { id: props.form.parentId, name: `ID ${props.form.parentId}` });

  return (
    <div className="space-y-5">
      <TextField
        label="Назва *"
        value={props.form.name}
        onChange={(event) => props.onChange({ name: event.target.value })}
        error={Boolean(props.formErrors.name)}
        helperText={props.formErrors.name || ' '}
        fullWidth
        disabled={props.isSubmitting}
      />

      <Autocomplete<Pick<Organism, 'id' | 'name'>>
        options={props.organisms}
        value={parentValue}
        onChange={(_, option) => {
          props.onChange({ parentId: option ? option.id : null });
        }}
        getOptionLabel={(option) => option.name || `ID ${option.id}`}
        isOptionEqualToValue={(option, value) => option.id === value.id}
        clearOnEscape
        disabled={props.isSubmitting || !globalAdmin}
        renderOption={(props, option) => {
          const { key: _unusedKey, ...optionProps } = props;
          return (
            <Box component="li" {...optionProps} key={option.id}>
              {option.name || `ID ${option.id}`}
            </Box>
          );
        }}
        renderInput={(params) => (
          <TextField {...params} label="Батьківський організм" placeholder="Без батька" fullWidth />
        )}
      />

      {globalAdmin ? (
        <>
          <TextField
            select
            label="Ролі"
            value={props.form.roles}
            onChange={(event) => props.onChange({ roles: asStringArray(event.target.value) })}
            fullWidth
            SelectProps={{
              multiple: true,
              renderValue: (selected) => (selected as string[]).join(', ') || '—',
            }}
            disabled={props.isSubmitting}
            helperText=" "
          >
            {ROLE_OPTIONS.map((role) => (
              <MenuItem key={role} value={role}>
                {role}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            label="Смуги"
            value={props.form.aorIds}
            onChange={(event) => props.onChange({ aorIds: asNumberArray(event.target.value) })}
            fullWidth
            SelectProps={{
              multiple: true,
              renderValue: (selected) => {
                const values = selected as number[];
                if (values.length === 0) return '—';
                return values
                  .map((id) =>
                    formatAorLabel(
                      props.aors.find((aor) => aor.id === id),
                      id,
                    ),
                  )
                  .join(', ');
              },
            }}
            disabled={props.isSubmitting}
            helperText=" "
          >
            {aorOptions}
          </TextField>

          <Box className="space-y-3 pt-2 pb-3">
            <Typography variant="subtitle2" className="text-muted-foreground">
              Доступні групи для організму
            </Typography>
            <Box className="mt-2 p-3 rounded-md bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
              {props.isComputing ? (
                <div className="flex items-center gap-2">
                  <CircularProgress size={18} />
                  <Typography variant="body2" className="text-muted-foreground italic">
                    Завантаження доступних груп...
                  </Typography>
                </div>
              ) : props.computeError ? (
                <SectionErrorState message={props.computeError} />
              ) : props.computedGroups ? (
                props.computedGroups.length === 0 ? (
                  <SectionEmptyState message="Немає доступних груп" />
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {props.computedGroups.map((group) => (
                      <span key={group.masterKey} className="badge badge--ochre-light">
                        {formatGroupLabel(group, group.masterKey)}
                      </span>
                    ))}
                  </div>
                )
              ) : (
                <Typography variant="body2" className="text-muted-foreground italic">
                  Оберіть смуги для отримання доступних груп
                </Typography>
              )}
            </Box>
            <Typography variant="caption" className="text-muted-foreground">
              Ці групи будуть доступні організму на основі вибраних смуг та батьківського організму
            </Typography>
          </Box>

          <div className="space-y-1">
            <FormControlLabel
              className="block"
              control={
                <Checkbox
                  checked={props.form.limitGroups}
                  onChange={() => props.onChange({ limitGroups: !props.form.limitGroups })}
                  disabled={props.isSubmitting}
                />
              }
              label="Обмежити перелік груп"
            />
            <Typography component="div" variant="caption" className="text-muted-foreground block">
              За замовчуванням організм має доступ до всіх груп від смуг. Увімкніть для додаткового
              обмеження.
            </Typography>
          </div>

          {props.form.limitGroups ? (
            <TextField
              select
              label="Обмежити групами"
              value={props.form.groupIds}
              onChange={(event) => props.onChange({ groupIds: asStringArray(event.target.value) })}
              fullWidth
              SelectProps={{
                multiple: true,
                renderValue: (selected) => {
                  const values = selected as string[];
                  if (values.length === 0) return '—';
                  return values
                    .map((groupId) => {
                      const group = props.groups.find((item) => item.masterKey === groupId);
                      return formatGroupLabel(group, groupId);
                    })
                    .join(', ');
                },
              }}
              disabled={props.isSubmitting}
            >
              {groupOptions}
            </TextField>
          ) : null}

          {props.form.limitGroups && props.groupsValidation.length > 0 ? (
            <Box className="p-3 rounded-md bg-yellow-50 border border-yellow-200 dark:bg-yellow-900/20 dark:border-yellow-800">
              <Typography variant="body2" className="text-yellow-800 dark:text-yellow-200">
                ⚠️ Попередження: при виборі цього батьківського організму буде втрачено доступ до
                груп: <strong>{props.groupsValidation.join(', ')}</strong>
              </Typography>
            </Box>
          ) : null}
        </>
      ) : null}

      {!props.isNew ? (
        <div className="pt-1">
          <FormControlLabel
            className="block"
            control={
              <Checkbox
                checked={props.form.enabled}
                onChange={() => props.onChange({ enabled: !props.form.enabled })}
                disabled={props.isSubmitting}
              />
            }
            label="Активна"
          />
        </div>
      ) : null}
    </div>
  );
}

export function OrganismGoiSection({ disabled }: { disabled: boolean }) {
  return (
    <Box className="space-y-4">
      <Typography variant="h6" className="font-semibold! pb-3">
        ГОІ
      </Typography>
      <PowerAlert severity="info">
        Керування інтеграціями ГОІ винесено в окрему адмін-панель. Тут налаштування організму більше
        не містять GOI конфігурацію.
      </PowerAlert>
      <div>
        <PowerButton
          variant="outlined"
          onClick={() => navigateWithinSpa('/admin/goi-integrations-neo')}
          disabled={disabled}
        >
          Відкрити панель ГОІ
        </PowerButton>
      </div>
    </Box>
  );
}
