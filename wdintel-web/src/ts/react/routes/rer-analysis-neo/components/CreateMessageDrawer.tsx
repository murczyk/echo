import React, { useState, useEffect, useRef } from 'react';
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
  Box,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/Delete';
import UploadFileIcon from '@mui/icons-material/UploadFile';

import Uppy from '@uppy/core';
import type { UppyFile } from '@uppy/core';
import Tus from '@uppy/tus';
import '@uppy/core/dist/style.min.css';
import '@uppy/dashboard/dist/style.min.css';

import {
  getUserSigintGroups,
  getGroupInfosBatch,
} from '../../../services/api/inbox-reference-data';
import {
  searchComputerName,
  searchComputerNames,
  createComputerName,
  createCyberEchoMessage,
} from '../../../services/api/cyber-echo-message';
import type { SignalGroupEntry } from '../../../../../Bindings';

const messageSchema = z.object({
  body: z.string().min(1, 'Повідомлення не може бути порожнім'),
  signalGroupMasterKey: z.string().min(1, 'Оберіть групу'),
  computerName: z.string().min(1, "Введіть або оберіть комп'ютер"),
});

type MessageFormData = z.infer<typeof messageSchema>;

type Props = {
  open: boolean;
  onClose: () => void;
  onSuccess?: (inboxItemId: number) => void;
};

export function CreateMessageDrawer({ open, onClose, onSuccess }: Props) {
  const [signalGroups, setSignalGroups] = useState<SignalGroupEntry[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [computerNameOptions, setComputerNameOptions] = useState<string[]>([]);
  const [computerNamesLoading, setComputerNamesLoading] = useState(false);
  const [computerNameInput, setComputerNameInput] = useState('');

  useEffect(() => {
    let active = true;

    setComputerNamesLoading(true);
    searchComputerNames(computerNameInput)
      .then((results) => {
        if (active) {
          setComputerNameOptions(results.map((c) => c.name));
        }
      })
      .catch(console.error)
      .finally(() => {
        if (active) setComputerNamesLoading(false);
      });

    return () => {
      active = false;
    };
  }, [computerNameInput]);

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

  const [uppyFiles, setUppyFiles] = useState<UppyFile<any, any>[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const updateFiles = () => setUppyFiles(uppy.getFiles());
    uppy.on('file-added', updateFiles);
    uppy.on('file-removed', updateFiles);
    return () => {
      uppy.off('file-added', updateFiles);
      uppy.off('file-removed', updateFiles);
    };
  }, [uppy]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      Array.from(e.target.files).forEach((file) => {
        try {
          uppy.addFile({
            name: file.name,
            type: file.type,
            data: file,
          });
        } catch (err: any) {
          setErrorMsg(err.message || 'Error adding file');
        }
      });
    }
    // reset input so the same file can be selected again if removed
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      Array.from(e.dataTransfer.files).forEach((file) => {
        try {
          uppy.addFile({
            name: file.name,
            type: file.type,
            data: file,
          });
        } catch (err: any) {
          setErrorMsg(err.message || 'Error adding file');
        }
      });
      e.dataTransfer.clearData();
    }
  };

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
        if (!uploadResult) {
          throw new Error('Помилка завантаження файлів (no result)');
        }
        if ((uploadResult.failed || []).length > 0) {
          throw new Error('Помилка завантаження файлів');
        }

        for (const file of uploadResult.successful || []) {
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
      const response = await createCyberEchoMessage({
        body: data.body,
        signal_group_master_key: data.signalGroupMasterKey,
        computer_name_id: computerNameId,
        upload_urls: uploadUrls.length > 0 ? uploadUrls : null,
      });

      onSuccess?.(response.inbox_item_id);
      handleDrawerClose();
    } catch (e: any) {
      console.error('Error creating message', e);
      setErrorMsg(e.message || 'Сталася невідома помилка');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={handleDrawerClose}
      sx={{ zIndex: 1200 }}
      slotProps={{
        paper: { sx: { width: { xs: '100%', sm: 500 }, maxWidth: '100vw', display: 'flex' } },
      }}
    >
      <div className="flex flex-col h-full flex-1 min-h-0">
        <div className="flex items-center justify-between p-[20px] border-b border-white/10">
          <Typography variant="h6">Створити повідомлення</Typography>
          <IconButton onClick={handleDrawerClose} disabled={submitting}>
            <CloseIcon />
          </IconButton>
        </div>

        <div className="flex-1 p-[20px] overflow-y-auto">
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
                  forcePopupIcon
                  options={computerNameOptions}
                  loading={computerNamesLoading}
                  value={field.value}
                  onInputChange={(_, newValue) => {
                    setComputerNameInput(newValue);
                    field.onChange(newValue);
                  }}
                  onChange={(_, newValue) => field.onChange(newValue || '')}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Назва комп'ютера"
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
                      label="Signal група"
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
                  rows={12}
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
              <div
                className={`border-2 border-dashed border-gray-500 rounded-md p-6 text-center cursor-pointer transition-colors ${submitting ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white/5 hover:border-blue-400'}`}
                onClick={() => !submitting && fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDrop={submitting ? undefined : handleDrop}
              >
                <input
                  type="file"
                  multiple
                  className="hidden"
                  ref={fileInputRef}
                  onChange={handleFileSelect}
                  disabled={submitting}
                />
                <Typography variant="body2" color="textSecondary">
                  Натисніть тут або перетягніть файли (до 20 файлів, до 2GB)
                </Typography>
              </div>

              {uppyFiles.length > 0 && (
                <div className="mt-4 flex flex-col gap-2">
                  {uppyFiles.map((f) => (
                    <div
                      key={f.id}
                      className="flex items-center justify-between p-2 border border-gray-600 rounded-md bg-white/5"
                    >
                      <Typography variant="body2" noWrap sx={{ flex: 1, mr: 2 }} title={f.name}>
                        {f.name}
                      </Typography>
                      <IconButton
                        size="small"
                        onClick={() => uppy.removeFile(f.id)}
                        disabled={submitting}
                      >
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </form>
        </div>

        <div className="flex justify-end gap-2 p-[20px] border-t border-white/10">
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
