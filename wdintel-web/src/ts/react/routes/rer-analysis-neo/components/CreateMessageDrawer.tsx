import { useState, useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  Drawer,
  Typography,
  TextField,
  Autocomplete,
  Button,
  IconButton,
  CircularProgress,
  Alert,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import Uppy from '@uppy/core';
import Tus from '@uppy/tus';
import { Dashboard } from '@uppy/react';

// Using regular import. In a real environment if uppy styling fails to resolve,
// Vite can handle direct imports from node_modules or CSS strings.
import '@uppy/core/dist/style.min.css';
import '@uppy/dashboard/dist/style.min.css';

import {
  getUserSigintGroups,
  getGroupInfosBatch,
} from '../../../services/api/inbox-reference-data';
import {
  searchComputerName,
  createComputerName,
  createCyberEchoMessage,
} from '../../../services/api/cyber-echo-message';
import type { SignalGroupEntry } from '../../../../Bindings';

const messageSchema = z.object({
  body: z.string().min(1, 'Повідомлення не може бути порожнім'),
  signalGroupMasterKey: z.string().min(1, 'Оберіть групу'),
  computerName: z.string().min(1, "Введіть або оберіть комп'ютер"),
});

type MessageFormData = z.infer<typeof messageSchema>;

type Props = {
  open: boolean;
  onClose: () => void;
};

export function CreateMessageDrawer({ open, onClose }: Props) {
  const [signalGroups, setSignalGroups] = useState<SignalGroupEntry[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [uppy] = useState(() =>
    new Uppy({
      restrictions: {
        maxNumberOfFiles: 20,
        maxFileSize: 2 * 1024 * 1024 * 1024, // 2GB
      },
      autoProceed: false,
    }).use(Tus, {
      endpoint: '/api/sigint/cyber-echo/tus',
      chunkSize: 5 * 1024 * 1024,
      limit: 3,
    }),
  );

  const {
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<MessageFormData>({
    resolver: zodResolver(messageSchema),
    defaultValues: {
      body: '',
      signalGroupMasterKey: '',
      computerName: '',
    },
  });

  useEffect(() => {
    if (!open) return;
    let active = true;

    const fetchGroups = async () => {
      setGroupsLoading(true);
      try {
        const keys = await getUserSigintGroups(null);
        if (!active) return;
        const infos = await getGroupInfosBatch(keys);
        if (!active) return;
        setSignalGroups(
          infos.filter((g) => {
            // Check if group is deleted
            const adminData = g.adminData as any;
            return !adminData?.deleted;
          }),
        );
      } catch (e) {
        console.error('Failed to load groups', e);
      } finally {
        if (active) setGroupsLoading(false);
      }
    };

    fetchGroups();

    return () => {
      active = false;
    };
  }, [open]);

  const handleDrawerClose = () => {
    if (submitting) return;
    uppy.cancelAll();
    reset();
    setErrorMsg(null);
    onClose();
  };

  const onSubmit = async (data: MessageFormData) => {
    setSubmitting(true);
    setErrorMsg(null);

    try {
      // 1. Resolve computer name
      let computerNameId: number;
      const searchRes = await searchComputerName(data.computerName);
      if (searchRes) {
        computerNameId = searchRes.id;
      } else {
        const createRes = await createComputerName(data.computerName);
        computerNameId = createRes.id;
      }

      // 2. Upload files if any
      const files = uppy.getFiles();
      const uploadUrls: string[] = [];

      if (files.length > 0) {
        const uploadResult = await uppy.upload();
        if (uploadResult.failed.length > 0) {
          throw new Error('Помилка завантаження файлів');
        }

        for (const file of uploadResult.successful) {
          // In Tus, the Location header is stored as uploadURL
          const url = file.tus?.uploadUrl || file.uploadURL || file.response?.uploadURL;
          if (url) {
            uploadUrls.push(url);
          } else {
            throw new Error(`Помилка: не знайдено URL для файлу ${file.name}`);
          }
        }
      }

      // 3. Create message
      await createCyberEchoMessage({
        body: data.body,
        signal_group_master_key: data.signalGroupMasterKey,
        computer_name_id: computerNameId,
        upload_urls: uploadUrls.length > 0 ? uploadUrls : null,
      });

      // Success
      handleDrawerClose();
    } catch (e: any) {
      console.error('Error creating message', e);
      setErrorMsg(e.message || 'Сталася невідома помилка');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer anchor="right" open={open} onClose={handleDrawerClose} sx={{ zIndex: 1200 }}>
      <div className="flex flex-col h-full w-[100vw] sm:w-[500px]">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <Typography variant="h6">Створити повідомлення</Typography>
          <IconButton onClick={handleDrawerClose} disabled={submitting}>
            <CloseIcon />
          </IconButton>
        </div>

        <div className="flex-1 p-4 overflow-y-auto">
          {errorMsg && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {errorMsg}
            </Alert>
          )}

          <form id="create-message-form" onSubmit={handleSubmit(onSubmit)}>
            <Controller
              name="computerName"
              control={control}
              render={({ field }) => (
                <Autocomplete
                  freeSolo
                  options={[]}
                  loading={false}
                  value={field.value}
                  onInputChange={(_, newValue) => field.onChange(newValue)}
                  onChange={(_, newValue) => field.onChange(newValue || '')}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Computer Name"
                      margin="normal"
                      fullWidth
                      error={!!errors.computerName}
                      helperText={errors.computerName?.message}
                      disabled={submitting}
                    />
                  )}
                />
              )}
            />

            <Controller
              name="signalGroupMasterKey"
              control={control}
              render={({ field }) => (
                <Autocomplete
                  options={signalGroups}
                  getOptionLabel={(option) => option.name || option.masterKey}
                  isOptionEqualToValue={(option, value) => option.masterKey === value.masterKey}
                  renderOption={(props, option) => {
                    const { key, ...restProps } = props as any;
                    return (
                      <li key={option.masterKey} {...restProps}>
                        {option.name || option.masterKey}
                      </li>
                    );
                  }}
                  loading={groupsLoading}
                  value={signalGroups.find((g) => g.masterKey === field.value) || null}
                  onChange={(_, newValue) => field.onChange(newValue?.masterKey || '')}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Signal Group"
                      margin="normal"
                      fullWidth
                      error={!!errors.signalGroupMasterKey}
                      helperText={errors.signalGroupMasterKey?.message}
                      disabled={submitting || groupsLoading}
                      InputProps={{
                        ...params.InputProps,
                        endAdornment: (
                          <>
                            {groupsLoading ? <CircularProgress color="inherit" size={20} /> : null}
                            {params.InputProps.endAdornment}
                          </>
                        ),
                      }}
                    />
                  )}
                />
              )}
            />

            <Controller
              name="body"
              control={control}
              render={({ field }) => (
                <TextField
                  {...field}
                  label="Текст повідомлення"
                  margin="normal"
                  fullWidth
                  multiline
                  rows={4}
                  error={!!errors.body}
                  helperText={errors.body?.message}
                  disabled={submitting}
                />
              )}
            />

            <div className="mt-6">
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Вкладення (Макс 20, до 2GB)
              </Typography>
              <Dashboard
                uppy={uppy}
                hideUploadButton // We trigger upload programmatically on form submit
                width="100%"
                height={300}
                proudlyDisplayPoweredByUppy={false}
              />
            </div>
          </form>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-gray-200">
          <Button onClick={handleDrawerClose} disabled={submitting}>
            Скасувати
          </Button>
          <Button
            type="submit"
            form="create-message-form"
            variant="contained"
            color="primary"
            disabled={submitting}
            startIcon={submitting && <CircularProgress size={20} color="inherit" />}
          >
            {submitting ? 'Збереження...' : 'Створити'}
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
