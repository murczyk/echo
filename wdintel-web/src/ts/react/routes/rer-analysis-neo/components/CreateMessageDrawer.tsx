import React, { useState, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import type { Dayjs } from 'dayjs';
import {
  Drawer,
  Typography,
  TextField,
  Autocomplete,
  Button,
  IconButton,
  CircularProgress,
  Box,
  Stack,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import Uppy from '@uppy/core';
import type { UppyFile } from '@uppy/core';
import Tus from '@uppy/tus';
import '@uppy/core/dist/style.min.css';
import '@uppy/dashboard/dist/style.min.css';

import {
  getUserSigintGroups,
  getGroupInfosBatch,
  getTagsForDisplay,
} from '../../../services/api/inbox-reference-data';
import {
  searchComputerName,
  searchComputerNames,
  createComputerName,
  submitCyberEchoMessage,
} from '../../../services/api/cyber-echo-message';
import type { SignalGroupEntry } from '../../../../../Bindings';
import { PowerDateTimePicker } from '../../../components/PowerDateTimePicker';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerForm } from '../../../components/PowerForm';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';

const FREQ_FORMAT_REGEX = /^\d+([.,]\d+)?$/;

function parseCoordLine(line: string): { lat: number; lon: number } | null {
  const parts = line.split(',').map((part) => part.trim());
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function normalizeMultiValue(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

const messageSchema = z
  .object({
    text: z.string().trim().min(1, 'Повідомлення не може бути порожнім'),
    signalGroupMasterKey: z.string().trim().min(1, 'Оберіть групу'),
    computerName: z.string().trim().min(1, "Введіть або оберіть комп'ютер"),
    message_uid: z.string().optional(),
    freq: z
      .string()
      .optional()
      .refine((value) => !value?.trim() || FREQ_FORMAT_REGEX.test(value.trim()), {
        message: 'Невірний формат частоти (напр. 149.5000)',
      }),
    coords: z.string().optional(),
    from_callsign: z.string().optional(),
    to_callsigns: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    timestamp: z.any().optional(),
    full_body: z.string().optional(),
    post: z.string().optional(),
    unit: z.string().optional(),
    locations: z.array(z.string()).optional(),
    network_signal_name: z.string().optional(),
    network_cc: z
      .string()
      .optional()
      .refine(
        (value) => {
          if (!value?.trim()) return true;
          const parsed = Number(value.trim());
          return Number.isInteger(parsed) && parsed >= 0 && parsed <= 15;
        },
        { message: 'Color Code має бути цілим числом від 0 до 15' },
      ),
    network_name: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.coords?.trim()) {
      const invalidLines: number[] = [];
      data.coords.split(/\r?\n/).forEach((line, index) => {
        if (!line.trim()) return;
        if (!parseCoordLine(line)) invalidLines.push(index + 1);
      });
      if (invalidLines.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['coords'],
          message: `Невірний формат координат, рядок${invalidLines.length > 1 ? 'и' : ''} ${invalidLines.join(', ')} (очікується "lat, lon")`,
        });
      }
    }

    if (
      (data.network_cc?.trim() || data.network_name?.trim()) &&
      !data.network_signal_name?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['network_signal_name'],
        message: 'Вкажіть назву сигналу мережі, якщо заповнено інші поля мережі',
      });
    }
  });

type MessageFormData = z.infer<typeof messageSchema>;

type Props = {
  open: boolean;
  onClose: () => void;
  onSuccess?: (inboxItemId: number) => void;
};

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack spacing={2}>
      <Typography variant="subtitle2">{title}</Typography>
      {children}
    </Stack>
  );
}

export function CreateMessageDrawer({ open, onClose, onSuccess }: Props) {
  const [signalGroups, setSignalGroups] = useState<SignalGroupEntry[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [tagOptions, setTagOptions] = useState<string[]>([]);

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

  const handleDropzoneKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (submitting) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  };

  const {
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<MessageFormData>({
    resolver: zodResolver(messageSchema),
    mode: 'onTouched',
    reValidateMode: 'onChange',
    defaultValues: {
      text: '',
      signalGroupMasterKey: '',
      computerName: '',
      message_uid: '',
      freq: '',
      coords: '',
      from_callsign: '',
      to_callsigns: [],
      tags: [],
      timestamp: null,
      full_body: '',
      post: '',
      unit: '',
      locations: [],
      network_signal_name: '',
      network_cc: '',
      network_name: '',
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

    getTagsForDisplay()
      .then(({ tagsMap, tagsOrder }) => {
        if (!active) return;
        setTagOptions(
          tagsOrder
            .map((tagId) => tagsMap[tagId]?.label)
            .filter((label): label is string => !!label),
        );
      })
      .catch((e) => console.error('Failed to load tags', e));

    return () => {
      active = false;
    };
  }, [open]);

  const handleDrawerClose = () => {
    if (submitting) return;
    uppy.cancelAll();
    reset();
    setComputerNameInput('');
    setErrorMsg(null);
    onClose();
  };

  const onSubmit = async (data: MessageFormData) => {
    if (submitting) return;
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
          const url = file.tus?.uploadUrl || file.uploadURL || file.response?.uploadURL;
          if (url) {
            uploadUrls.push(url);
          } else {
            throw new Error(`Помилка: не знайдено URL для файлу ${file.name}`);
          }
        }
      }

      // Parse coordinates (already validated by the form schema)
      const coordsResult: { lat: number; lon: number }[] = [];
      if (data.coords && data.coords.trim()) {
        for (const line of data.coords.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const coord = parseCoordLine(line);
          if (coord) coordsResult.push(coord);
        }
      }

      // Build network object
      let networkObj: any = undefined;
      if (data.network_signal_name || data.network_cc || data.network_name) {
        networkObj = {
          signal_name: data.network_signal_name || undefined,
          cc: data.network_cc ? parseInt(data.network_cc, 10) : undefined,
          name: data.network_name || undefined,
        };
      }

      // 3. Create message
      const response = await submitCyberEchoMessage({
        text: data.text,
        message_uid: data.message_uid || undefined,
        signal_group_master_key: data.signalGroupMasterKey,
        device_name_id: computerNameId,
        upload_urls: uploadUrls.length > 0 ? uploadUrls : null,
        delete_media_ids: [], // Not supporting editing existing media from UI right now
        freq: data.freq || undefined,
        coords: coordsResult.length > 0 ? coordsResult : undefined,
        from_callsign: data.from_callsign || undefined,
        to_callsigns: data.to_callsigns?.length ? data.to_callsigns : undefined,
        tags: data.tags?.length ? data.tags : undefined,
        timestamp: data.timestamp ? (data.timestamp as Dayjs).toISOString() : undefined,
        full_body: data.full_body || undefined,
        post: data.post || undefined,
        unit: data.unit || undefined,
        locations: data.locations?.length ? data.locations : undefined,
        network: networkObj,
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
      onClose={submitting ? undefined : handleDrawerClose}
      sx={{ zIndex: 1200 }}
      ModalProps={{
        BackdropProps: {
          sx: (theme) => pageDrawerBackdropSx(theme),
        },
      }}
      slotProps={{
        paper: {
          sx: {
            width: { xs: '100%', sm: 680 },
            maxWidth: '100vw',
            display: 'flex',
            backgroundColor: 'background.default',
            backgroundImage: 'none',
          },
        },
      }}
    >
      <div className="flex flex-col h-full flex-1 min-h-0">
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            p: 2.5,
            borderBottom: '1px solid',
            borderColor: 'divider',
          }}
        >
          <Typography variant="h6">Створити повідомлення</Typography>
          <IconButton onClick={handleDrawerClose} disabled={submitting}>
            <CloseIcon />
          </IconButton>
        </Box>

        <Box sx={{ flex: 1, p: 2.5, overflowY: 'auto' }}>
          {errorMsg && (
            <PowerAlert severity="error" onClose={() => setErrorMsg(null)} sx={{ mb: 2 }}>
              {errorMsg}
            </PowerAlert>
          )}

          <PowerForm
            id="create-message-form"
            noValidate
            onSubmit={handleSubmit(onSubmit)}
            canSubmit={!submitting}
            sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}
          >
            {/* System / Required */}
            <FormSection title="Системні (обов'язково)">
              <Box
                sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}
              >
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
                          size="small"
                          fullWidth
                          required
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
                          label="Сигнальна група"
                          size="small"
                          fullWidth
                          required
                          error={!!errors.signalGroupMasterKey}
                          helperText={errors.signalGroupMasterKey?.message}
                          disabled={submitting || groupsLoading}
                          slotProps={{
                            input: {
                              ...params.InputProps,
                              endAdornment: (
                                <>
                                  {groupsLoading ? (
                                    <CircularProgress color="inherit" size={20} />
                                  ) : null}
                                  {params.InputProps.endAdornment}
                                </>
                              ),
                            },
                          }}
                        />
                      )}
                    />
                  )}
                />
              </Box>
            </FormSection>

            {/* Content */}
            <FormSection title="Зміст (текст повідомлення)">
              <Controller
                name="text"
                control={control}
                render={({ field }) => (
                  <TextField
                    {...field}
                    label="Текст повідомлення"
                    required
                    fullWidth
                    multiline
                    rows={6}
                    error={!!errors.text}
                    helperText={errors.text?.message}
                    disabled={submitting}
                  />
                )}
              />
              <Controller
                name="full_body"
                control={control}
                render={({ field }) => (
                  <TextField
                    {...field}
                    label="Повна форма повідомлення (опційно)"
                    fullWidth
                    multiline
                    rows={4}
                    disabled={submitting}
                  />
                )}
              />
            </FormSection>

            {/* Meta */}
            <FormSection title="Метадані повідомлення">
              <Box
                sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}
              >
                <Controller
                  name="timestamp"
                  control={control}
                  render={({ field }) => (
                    <PowerDateTimePicker
                      label="Час перехоплення"
                      value={field.value}
                      allowEmpty
                      onChange={(newValue) => field.onChange(newValue)}
                      disabled={submitting}
                      slotProps={{ textField: { size: 'small', fullWidth: true } }}
                    />
                  )}
                />

                <Controller
                  name="message_uid"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      label="Зовнішній ідентифікатор"
                      size="small"
                      fullWidth
                      disabled={submitting}
                    />
                  )}
                />
              </Box>

              <Box
                sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}
              >
                <Controller
                  name="post"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      label="Пост"
                      size="small"
                      fullWidth
                      disabled={submitting}
                    />
                  )}
                />

                <Controller
                  name="unit"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      label="Підрозділ"
                      size="small"
                      fullWidth
                      disabled={submitting}
                    />
                  )}
                />
              </Box>

              <Controller
                name="tags"
                control={control}
                render={({ field }) => (
                  <Autocomplete
                    multiple
                    options={tagOptions}
                    value={field.value}
                    onChange={(_, newValue) =>
                      field.onChange(normalizeMultiValue(newValue as string[]))
                    }
                    renderInput={(params) => <TextField {...params} label="Теги" size="small" />}
                    disabled={submitting}
                  />
                )}
              />
            </FormSection>

            {/* Network */}
            <FormSection title="Мережа та радіо">
              <Box
                sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}
              >
                <Controller
                  name="freq"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      label="Частота (МГц)"
                      placeholder="напр. 149.5000"
                      size="small"
                      fullWidth
                      error={!!errors.freq}
                      helperText={errors.freq?.message}
                      disabled={submitting}
                    />
                  )}
                />
                <Controller
                  name="network_cc"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      label="Колірний код (CC)"
                      placeholder="0–15"
                      size="small"
                      type="number"
                      fullWidth
                      error={!!errors.network_cc}
                      helperText={errors.network_cc?.message}
                      disabled={submitting}
                    />
                  )}
                />
              </Box>

              <Box
                sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}
              >
                <Controller
                  name="network_signal_name"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      label="Назва сигналу мережі"
                      size="small"
                      fullWidth
                      error={!!errors.network_signal_name}
                      helperText={errors.network_signal_name?.message}
                      disabled={submitting}
                    />
                  )}
                />
                <Controller
                  name="network_name"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      label="Назва мережі"
                      size="small"
                      fullWidth
                      disabled={submitting}
                    />
                  )}
                />
              </Box>

              <Box
                sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}
              >
                <Controller
                  name="from_callsign"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      label="Від кого (позивний)"
                      size="small"
                      fullWidth
                      disabled={submitting}
                    />
                  )}
                />

                <Controller
                  name="to_callsigns"
                  control={control}
                  render={({ field }) => (
                    <Autocomplete
                      multiple
                      freeSolo
                      options={[]}
                      value={field.value}
                      onChange={(_, newValue) =>
                        field.onChange(normalizeMultiValue(newValue as string[]))
                      }
                      renderInput={(params) => (
                        <TextField {...params} label="Кому (позивні)" size="small" />
                      )}
                      disabled={submitting}
                    />
                  )}
                />
              </Box>
            </FormSection>

            {/* Locations */}
            <FormSection title="Локації та координати">
              <Controller
                name="locations"
                control={control}
                render={({ field }) => (
                  <Autocomplete
                    multiple
                    freeSolo
                    options={[]}
                    value={field.value}
                    onChange={(_, newValue) =>
                      field.onChange(normalizeMultiValue(newValue as string[]))
                    }
                    renderInput={(params) => (
                      <TextField {...params} label="Назви локацій" size="small" />
                    )}
                    disabled={submitting}
                  />
                )}
              />

              <Controller
                name="coords"
                control={control}
                render={({ field }) => (
                  <TextField
                    {...field}
                    label="Координати (lat, lon) по одній на рядок"
                    multiline
                    rows={3}
                    fullWidth
                    error={!!errors.coords}
                    helperText={errors.coords?.message}
                    disabled={submitting}
                    placeholder="49.12345, 37.12345&#10;49.54321, 37.54321"
                  />
                )}
              />
            </FormSection>

            {/* Attachments */}
            <FormSection title={`Вкладення (${uppyFiles.length})`}>
              <Box
                role="button"
                tabIndex={submitting ? -1 : 0}
                aria-disabled={submitting}
                aria-label="Додати файли"
                onClick={() => !submitting && fileInputRef.current?.click()}
                onKeyDown={handleDropzoneKeyDown}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDrop={submitting ? undefined : handleDrop}
                sx={{
                  border: '2px dashed',
                  borderColor: 'divider',
                  borderRadius: 1.5,
                  p: 3,
                  textAlign: 'center',
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  opacity: submitting ? 0.5 : 1,
                  transition: 'background-color 150ms ease, border-color 150ms ease',
                  '&:hover': submitting
                    ? undefined
                    : { bgcolor: 'action.hover', borderColor: 'primary.main' },
                  '&:focus-visible': {
                    outline: '2px solid',
                    outlineColor: 'primary.main',
                    outlineOffset: 2,
                  },
                }}
              >
                <input
                  type="file"
                  multiple
                  className="hidden"
                  ref={fileInputRef}
                  onChange={handleFileSelect}
                  disabled={submitting}
                />
                <Typography variant="body2" color="text.secondary">
                  Натисніть тут або перетягніть файли (до 20 файлів, до 2GB)
                </Typography>
              </Box>

              {uppyFiles.length > 0 && (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {uppyFiles.map((f) => (
                    <Box
                      key={f.id}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        p: 1,
                        border: '1px solid',
                        borderColor: 'divider',
                        borderRadius: 1,
                        bgcolor: 'action.hover',
                      }}
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
                    </Box>
                  ))}
                </Box>
              )}
            </FormSection>
          </PowerForm>
        </Box>

        <Box
          sx={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 2,
            p: 2.5,
            borderTop: '1px solid',
            borderColor: 'divider',
          }}
        >
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
        </Box>
      </div>
    </Drawer>
  );
}
