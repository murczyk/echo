import React, { useState, useEffect, useMemo, useRef } from 'react';
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
  Chip,
  Tooltip,
  Box,
  Stack,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import AddIcon from '@mui/icons-material/Add';
import CloudUploadOutlinedIcon from '@mui/icons-material/CloudUploadOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import MovieOutlinedIcon from '@mui/icons-material/MovieOutlined';
import AudiotrackOutlinedIcon from '@mui/icons-material/AudiotrackOutlined';
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined';
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import type { SvgIconComponent } from '@mui/icons-material';

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
  parseDirectSubmit,
  submitDirect,
} from '../../../services/api/direct-submit';
import type { InboxMessage, SignalGroupEntry, Tag, User } from '../../../../../Bindings';
import { PowerDatePicker } from '../../../components/PowerDateTimePicker';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerForm } from '../../../components/PowerForm';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import { hasRole } from '../../../utils/roles';
import { isPresent } from '../../../utils/misc';
import { mapFormToInboxMessage, mapInboxMessageToForm } from './create-message-drawer.mappers';
import { parseCoordinateInput } from '../../../../maps/coordinate-search';
import { TimePicker } from '@mui/x-date-pickers/TimePicker';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import dayjs from 'dayjs';

const FREQ_FORMAT_REGEX = /^\d+([.,]\d+)?$/;

// Accepts either WGS84 decimal degrees ("lat, lon") or an MGRS grid reference
// ("37U DR 05997 22279") on a single line, returning backend {lat, lon}.
function parseCoordLine(line: string): { lat: number; lon: number } | null {
  const parsed = parseCoordinateInput(line);
  if (!parsed) return null;
  return { lat: parsed.lat, lon: parsed.lng };
}

function normalizeMultiValue(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    // Split comma-separated free-text so "дождь, синий" becomes two chips.
    for (const part of raw.split(',')) {
      const trimmed = part.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

function normalizeCallsign(value: string): string {
  return value.trim().toUpperCase();
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : '';
}

function attachmentIcon(name: string, mimeType: string | undefined): SvgIconComponent {
  const type = (mimeType ?? '').toLowerCase();
  if (type.startsWith('image/')) return ImageOutlinedIcon;
  if (type.startsWith('video/')) return MovieOutlinedIcon;
  if (type.startsWith('audio/')) return AudiotrackOutlinedIcon;
  const ext = fileExtension(name).toLowerCase();
  if (type === 'application/pdf' || ext === 'pdf') return PictureAsPdfOutlinedIcon;
  if (['xlsx', 'xls', 'csv', 'ods'].includes(ext)) return TableChartOutlinedIcon;
  if (['doc', 'docx', 'odt', 'rtf', 'txt'].includes(ext)) return DescriptionOutlinedIcon;
  return InsertDriveFileOutlinedIcon;
}

function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const rounded = size >= 10 || unitIndex === 0 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

function makeMessageSchema(isEditMode: boolean) {
  return z
    .object({
      text: z.string().optional(),
      // Edit mode seeds this from the (possibly empty) existing message and renders the
      // field disabled, so the user has no way to fix a "required" failure — relax it.
      signalGroupMasterKey: z
        .string()
        .trim()
        .refine((value) => isEditMode || value.length > 0, { message: 'Оберіть групу' }),
      computerName: z.string().optional(),
      freq: z
        .string()
        .optional()
        .refine((value) => isEditMode || !value?.trim() || FREQ_FORMAT_REGEX.test(value.trim()), {
          message: 'Невірний формат частоти (напр. 149.5000)',
        }),
      coords: z.string().optional(),
      callsigns: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      date: z.any().optional(),
      time: z.any().optional(),
      full_body: z.string().optional(),
      comment: z.string().optional(),
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
      // Edit mode hides/free-forms these fields (coords may be legacy free-text; network
      // fields are hidden entirely) — the create-only cross-field rules don't apply.
      if (isEditMode) return;

      if (data.coords?.trim() && !parseCoordLine(data.coords)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['coords'],
          message: 'Невірний формат координат (очікується "lat, lon" або MGRS)',
        });
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
}

// Field types are identical between the create/edit variants (only refine behavior
// differs), so infer from the create-mode schema.
type MessageFormData = z.infer<ReturnType<typeof makeMessageSchema>>;

const EMPTY_FORM_VALUES: MessageFormData = {
  text: '',
  signalGroupMasterKey: '',
  computerName: '',
  freq: '',
  coords: '',
  callsigns: [],
  tags: [],
  date: null,
  time: null,
  full_body: '',
  comment: '',
  post: '',
  unit: '',
  locations: [],
  network_signal_name: '',
  network_cc: '',
  network_name: '',
};

type Props = {
  open: boolean;
  cyberEchoEnabled: boolean;
  currentUser: User | null;
  onClose: () => void;
  onSuccess?: () => void;
  editTarget?: { id: number; message: InboxMessage } | null;
  editSaveInFlight?: boolean;
  onSubmitEdit?: (id: number, message: InboxMessage) => void | Promise<void>;
};

function FormSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Stack spacing={2}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          minHeight: 32,
        }}
      >
        <Typography variant="subtitle2">{title}</Typography>
        {action}
      </Box>
      {children}
    </Stack>
  );
}

export function CreateMessageDrawer({
  open,
  cyberEchoEnabled,
  currentUser,
  onClose,
  onSuccess,
  editTarget = null,
  editSaveInFlight,
  onSubmitEdit,
}: Props) {
  const isAdmin = hasRole(currentUser?.roles, 'Admin');
  const isEditMode = isPresent(editTarget);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [signalGroups, setSignalGroups] = useState<SignalGroupEntry[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const busy = submitting || (isEditMode && Boolean(editSaveInFlight));

  const [tagOptions, setTagOptions] = useState<string[]>([]);
  const [tagsMap, setTagsMap] = useState<Record<number, Tag>>({});

  const [computerNameOptions, setComputerNameOptions] = useState<string[]>([]);
  const [computerNamesLoading, setComputerNamesLoading] = useState(false);
  const [computerNameInput, setComputerNameInput] = useState('');

  const [callsignDraft, setCallsignDraft] = useState('');

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
      endpoint: '/api/sigint/file-upload/tus',
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
    if (busy) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  };

  const resolver = useMemo(() => zodResolver(makeMessageSchema(isEditMode)), [isEditMode]);

  const {
    control,
    getValues,
    handleSubmit,
    reset,
    setValue,
    trigger,
    formState: { errors },
  } = useForm<MessageFormData>({
    resolver,
    mode: 'onTouched',
    reValidateMode: 'onChange',
    defaultValues: EMPTY_FORM_VALUES,
  });

  const handleParse = async () => {
    if (parsing || busy) return;
    const fullBody = getValues('full_body')?.trim();
    const signalGroupMasterKey = getValues('signalGroupMasterKey')?.trim();
    if (!fullBody) {
      setErrorMsg('Введіть текст повідомлення');
      return;
    }

    setParsing(true);
    setErrorMsg(null);
    try {
      const parsed = await parseDirectSubmit({
        full_body: fullBody,
        // The group only refines unit/location extraction; parsing works without it.
        ...(signalGroupMasterKey ? { signal_group_master_key: signalGroupMasterKey } : {}),
      });
      const timestamp = parsed.timestamp ? dayjs(parsed.timestamp) : null;
      // Parsing overwrites fields with the freshly parsed values every time it
      // runs, so re-parsing after editing the source text updates the form.
      const fillText = (
        name: 'text' | 'freq' | 'coords' | 'comment' | 'post' | 'unit',
        value: string,
      ) => {
        if (!value) return;
        setValue(name, value, { shouldDirty: true, shouldValidate: true });
      };
      const fillList = (name: 'callsigns' | 'locations', value: string[]) => {
        if (value.length === 0) return;
        setValue(name, value, { shouldDirty: true, shouldValidate: true });
      };
      fillText('text', parsed.text);
      fillText('freq', parsed.freq ?? '');
      fillText(
        'coords',
        parsed.coords[0] ? `${parsed.coords[0].lat}, ${parsed.coords[0].lon}` : '',
      );
      fillText('comment', parsed.comment ?? '');
      fillText('post', parsed.post ?? '');
      fillText('unit', parsed.unit ?? '');
      fillList('callsigns', parsed.to);
      fillList('locations', parsed.locations);
      if (timestamp?.isValid()) {
        setValue('date', timestamp, { shouldDirty: true });
        setValue('time', timestamp, { shouldDirty: true });
      }
    } catch (error: any) {
      console.error('Error parsing message', error);
      setErrorMsg(error.message || 'Не вдалося розпарсити повідомлення');
    } finally {
      setParsing(false);
    }
  };

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
        setTagsMap(tagsMap);
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

  useEffect(() => {
    if (!open) return;
    // Seed the form every time the drawer opens so state never leaks between sessions
    // (e.g. opening create right after edit). Edit-save closes the drawer by clearing
    // `editorMessage` rather than going through `handleDrawerClose`, so the reset must
    // happen on open, not only on close. Also clear the auxiliary local UI state that
    // `handleDrawerClose` normally resets, for the same reason.
    setCallsignDraft('');
    setComputerNameInput('');
    setShowAdvanced(false);
    setErrorMsg(null);
    if (isEditMode && editTarget) {
      // `tagsMap` is intentionally NOT a dependency here so a fast user's edits are not
      // clobbered when the async fetch resolves; the `tags` field is patched separately
      // below once tags load.
      reset({
        ...mapInboxMessageToForm(editTarget.message, tagsMap),
        // create-only fields kept at defaults in edit mode:
        text: editTarget.message.text ?? '',
        signalGroupMasterKey: editTarget.message.groupMasterKey ?? '',
        computerName: '',
        network_signal_name: '',
        network_cc: '',
        network_name: '',
      });
    } else {
      reset(EMPTY_FORM_VALUES);
    }
  }, [open, isEditMode, editTarget?.id]);

  // Tags depend on the async `tagsMap`. Once it loads, backfill the `tags` field — but
  // only when it is still empty, so a user who added tags in the loading window keeps them.
  useEffect(() => {
    if (!open || !isEditMode || !editTarget) return;
    if ((getValues('tags') ?? []).length > 0) return;
    const seededTags = mapInboxMessageToForm(editTarget.message, tagsMap).tags;
    if (seededTags.length > 0) {
      setValue('tags', seededTags, { shouldDirty: false });
    }
  }, [open, isEditMode, editTarget?.id, tagsMap]);

  const handleDrawerClose = () => {
    if (busy) return;
    uppy.cancelAll();
    reset();
    setComputerNameInput('');
    setShowAdvanced(false);
    setErrorMsg(null);
    onClose();
  };

  const getProposedCallsigns = (current: string[]): string[] => {
    const present = new Set(current.map(normalizeCallsign));
    return (editTarget?.message.callsignsAlg2 ?? [])
      .map(normalizeCallsign)
      .filter((item) => item.length > 0 && item.length <= 12 && !present.has(item))
      .filter((item, index, list) => list.indexOf(item) === index);
  };

  const addCallsign = () => {
    const nextCallsign = normalizeCallsign(callsignDraft);
    if (!nextCallsign) return;
    const current = getValues('callsigns') ?? [];
    if (current.map(normalizeCallsign).includes(nextCallsign)) {
      setCallsignDraft('');
      return;
    }
    setValue('callsigns', [...current, nextCallsign], { shouldDirty: true });
    setCallsignDraft('');
  };

  const removeCallsign = (callsign: string) => {
    const current = getValues('callsigns') ?? [];
    setValue(
      'callsigns',
      current.filter((item) => normalizeCallsign(item) !== normalizeCallsign(callsign)),
      { shouldDirty: true },
    );
  };

  const addSuggestedCallsign = (callsign: string) => {
    const current = getValues('callsigns') ?? [];
    if (current.some((item) => normalizeCallsign(item) === callsign)) return;
    setValue('callsigns', [...current, callsign], { shouldDirty: true });
  };

  const onSubmit = async (data: MessageFormData) => {
    if (busy) return;

    if (isEditMode && editTarget && onSubmitEdit) {
      const labelToTagId = new Map(
        Object.entries(tagsMap).map(([id, tag]) => [tag.label, Number(id)]),
      );
      const merged = mapFormToInboxMessage(
        editTarget.message,
        {
          full_body: data.full_body ?? '',
          comment: data.comment ?? '',
          date: (data.date as Dayjs | null) ?? null,
          time: (data.time as Dayjs | null) ?? null,
          freq: data.freq ?? '',
          coords: data.coords ?? '',
          callsigns: data.callsigns ?? [],
          post: data.post ?? '',
          unit: data.unit ?? '',
          locations: data.locations ?? [],
          tags: data.tags ?? [],
        },
        labelToTagId,
      );
      // tagsMap hasn't loaded yet (e.g. user saves during the initial fetch): the seeded
      // `data.tags` is still empty, so `merged.tags` would be null and wipe the original
      // message's tags. Preserve them instead of overwriting with an empty selection.
      if (Object.keys(tagsMap).length === 0) {
        merged.tags = editTarget.message.tags;
      }
      await onSubmitEdit(editTarget.id, merged);
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);

    try {
      // 1. Resolve optional device name
      let computerNameId: number | undefined;
      const computerName = data.computerName?.trim();
      if (computerName) {
        const searchRes = await searchComputerName(computerName);
        if (searchRes) {
          computerNameId = searchRes.id;
        } else {
          const createRes = await createComputerName(computerName);
          computerNameId = createRes.id;
        }
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

      // Parse the single coordinate (already validated by the form schema).
      const coordsResult: { lat: number; lon: number }[] = [];
      if (data.coords && data.coords.trim()) {
        const coord = parseCoordLine(data.coords);
        if (coord) coordsResult.push(coord);
      }

      // Merge separate date + time UI fields into a single ISO timestamp.
      // Either field alone is enough; the missing part falls back to the start of day.
      const dateValue = data.date as Dayjs | null;
      const timeValue = data.time as Dayjs | null;
      let timestamp: string | undefined;
      if (dateValue || timeValue) {
        const base = (dateValue ?? dayjs()).startOf('day');
        const merged = timeValue
          ? base.hour(timeValue.hour()).minute(timeValue.minute()).second(timeValue.second())
          : base;
        timestamp = merged.toISOString();
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
      await submitDirect({
        full_body: data.full_body?.trim() || undefined,
        text: data.text?.trim() || undefined,
        comment: data.comment?.trim() || undefined,
        signal_group_master_key: data.signalGroupMasterKey,
        device_name_id: computerNameId,
        upload_urls: uploadUrls.length > 0 ? uploadUrls : null,
        freq: data.freq || undefined,
        coords: coordsResult,
        to: data.callsigns || [],
        tags: data.tags || [],
        timestamp,
        post: data.post || undefined,
        unit: data.unit || undefined,
        locations: data.locations || [],
        network: networkObj,
      });

      onSuccess?.();
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
      onClose={busy ? undefined : handleDrawerClose}
      sx={{ zIndex: 1200 }}
      ModalProps={{
        BackdropProps: {
          sx: (theme) => pageDrawerBackdropSx(theme),
        },
      }}
      slotProps={{
        paper: {
          sx: {
            width: { xs: '100%', sm: 720, md: 1040 },
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
          <Typography variant="h6">
            {isEditMode ? 'Редагувати повідомлення' : 'Створити повідомлення'}
          </Typography>
          <IconButton onClick={handleDrawerClose} disabled={busy}>
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
            canSubmit={!busy}
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(0, 1fr)' },
              gap: 3,
              alignItems: 'start',
            }}
          >
            {/* LEFT COLUMN: raw message text, parse action, attachments */}
            <Stack spacing={2.5}>
              <FormSection
                title="Джерело"
                action={
                  !isEditMode && (
                    <Button
                      onClick={handleParse}
                      variant="outlined"
                      size="small"
                      startIcon={
                        parsing ? (
                          <CircularProgress size={16} color="inherit" />
                        ) : (
                          <AutoFixHighIcon />
                        )
                      }
                      disabled={busy || parsing}
                    >
                      Розпарсити
                    </Button>
                  )
                }
              >
                <Controller
                  name="full_body"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      label="Текст повідомлення"
                      fullWidth
                      multiline
                      rows={12}
                      disabled={busy}
                    />
                  )}
                />
              </FormSection>

              {/* Attachments */}
              {!isEditMode && (
                <FormSection title={`Вкладення (${uppyFiles.length})`}>
                  <Box
                    role="button"
                    tabIndex={busy ? -1 : 0}
                    aria-disabled={busy}
                    aria-label="Додати файли"
                    onClick={() => !busy && fileInputRef.current?.click()}
                    onKeyDown={handleDropzoneKeyDown}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onDrop={busy ? undefined : handleDrop}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1.5,
                      border: '1px dashed',
                      borderColor: 'divider',
                      borderRadius: 1.5,
                      py: 1,
                      px: 1.5,
                      cursor: busy ? 'not-allowed' : 'pointer',
                      opacity: busy ? 0.5 : 1,
                      transition: 'background-color 150ms ease, border-color 150ms ease',
                      '&:hover': busy
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
                      disabled={busy}
                    />
                    <CloudUploadOutlinedIcon
                      fontSize="small"
                      sx={{ color: 'text.secondary', flexShrink: 0 }}
                    />
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2" color="text.secondary" noWrap>
                        Натисніть або перетягніть файли сюди
                      </Typography>
                      <Typography variant="caption" color="text.disabled" noWrap component="div">
                        До 20 файлів, до 2 ГБ кожен
                      </Typography>
                    </Box>
                  </Box>

                  {uppyFiles.length > 0 && (
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                      {uppyFiles.map((f) => {
                        const fileName = f.name ?? '';
                        const FileIcon = attachmentIcon(fileName, f.type);
                        const ext = fileExtension(fileName);
                        const size = formatFileSize(f.size);
                        const meta = [ext, size].filter(Boolean).join(' · ');
                        return (
                          <Box
                            key={f.id}
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 1,
                              py: 0.5,
                              px: 1,
                              border: '1px solid',
                              borderColor: 'divider',
                              borderRadius: 1,
                              bgcolor: 'action.hover',
                            }}
                          >
                            <FileIcon
                              fontSize="small"
                              sx={{ color: 'text.secondary', flexShrink: 0 }}
                            />
                            <Typography
                              variant="body2"
                              noWrap
                              title={fileName}
                              sx={{ flex: 1, minWidth: 0 }}
                            >
                              {fileName}
                            </Typography>
                            {meta && (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                              >
                                {meta}
                              </Typography>
                            )}
                            <IconButton
                              size="small"
                              aria-label={`Видалити ${fileName}`}
                              onClick={() => uppy.removeFile(f.id)}
                              disabled={busy}
                            >
                              <CloseIcon fontSize="small" />
                            </IconButton>
                          </Box>
                        );
                      })}
                    </Box>
                  )}
                </FormSection>
              )}
            </Stack>

            {/* RIGHT COLUMN: structured fields (populated by parsing) */}
            <Stack spacing={2.5}>
              {/* System / Required */}
              <FormSection title="Системні">
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                    gap: 2,
                  }}
                >
                  <Controller
                    name="signalGroupMasterKey"
                    control={control}
                    render={({ field }) => (
                      <Autocomplete
                        options={signalGroups}
                        getOptionLabel={(option) => option.name || option.masterKey}
                        isOptionEqualToValue={(option, value) =>
                          option.masterKey === value.masterKey
                        }
                        renderOption={(props, option) => {
                          const { key, ...restProps } = props as any;
                          return (
                            <li key={option.masterKey} {...restProps}>
                              {option.name || option.masterKey}
                            </li>
                          );
                        }}
                        loading={groupsLoading}
                        disabled={busy || isEditMode}
                        value={signalGroups.find((g) => g.masterKey === field.value) || null}
                        onChange={(_, newValue) => field.onChange(newValue?.masterKey || '')}
                        renderInput={(params) => (
                          <TextField
                            {...params}
                            label="Група"
                            size="small"
                            fullWidth
                            required
                            error={!!errors.signalGroupMasterKey}
                            helperText={errors.signalGroupMasterKey?.message}
                            disabled={busy || isEditMode || groupsLoading}
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

                  {cyberEchoEnabled && (
                    <Controller
                      name="computerName"
                      control={control}
                      render={({ field }) => (
                        <Autocomplete
                          freeSolo
                          forcePopupIcon
                          options={computerNameOptions}
                          loading={computerNamesLoading}
                          value={field.value ?? ''}
                          disabled={busy || isEditMode}
                          onInputChange={(_, newValue, reason) => {
                            // MUI also fires this with reason "reset"/"clear" whenever
                            // `value` changes programmatically (e.g. RHF's reset() after
                            // submit, or when an option is picked from the list) — forwarding
                            // those into field.onChange re-triggers validation and leaves a
                            // stale "required" error visible after the drawer is reopened.
                            if (reason !== 'input') return;
                            setComputerNameInput(newValue);
                            field.onChange(newValue);
                          }}
                          onChange={(_, newValue) => {
                            const resolved = newValue || '';
                            setComputerNameInput(resolved);
                            field.onChange(resolved);
                          }}
                          renderInput={(params) => (
                            <TextField
                              {...params}
                              label="Назва комп'ютера"
                              size="small"
                              fullWidth
                              disabled={busy || isEditMode}
                            />
                          )}
                        />
                      )}
                    />
                  )}
                </Box>
              </FormSection>

              {/* Short message (advanced, create-only) */}
              {!isEditMode && showAdvanced && (
                <Controller
                  name="text"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      label="Коротке повідомлення"
                      fullWidth
                      multiline
                      rows={4}
                      error={!!errors.text}
                      helperText={errors.text?.message}
                      disabled={busy}
                    />
                  )}
                />
              )}

              {/* Meta */}
              <FormSection title="Метадані повідомлення">
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                    gap: 2,
                  }}
                >
                  <Controller
                    name="date"
                    control={control}
                    render={({ field }) => (
                      <PowerDatePicker
                        label="Дата перехоплення"
                        value={field.value}
                        allowEmpty
                        onChange={(newValue) => field.onChange(newValue)}
                        disabled={busy}
                        slotProps={{ textField: { size: 'small', fullWidth: true } }}
                      />
                    )}
                  />

                  <Controller
                    name="time"
                    control={control}
                    render={({ field }) => (
                      <LocalizationProvider dateAdapter={AdapterDayjs} adapterLocale="uk">
                        <TimePicker
                          label="Час перехоплення"
                          value={field.value ?? null}
                          ampm={false}
                          onChange={(newValue) => field.onChange(newValue)}
                          disabled={busy}
                          slotProps={{ textField: { size: 'small', fullWidth: true } }}
                        />
                      </LocalizationProvider>
                    )}
                  />
                </Box>

                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                    gap: 2,
                  }}
                >
                  <Controller
                    name="post"
                    control={control}
                    render={({ field }) => (
                      <TextField {...field} label="Пост" size="small" fullWidth disabled={busy} />
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
                        disabled={busy}
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
                      disabled={busy}
                    />
                  )}
                />
              </FormSection>

              {/* Network */}
              <FormSection title="Мережа та радіо">
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                    gap: 2,
                  }}
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
                        disabled={busy}
                      />
                    )}
                  />
                  {!isEditMode && (
                    <Controller
                      name="network_cc"
                      control={control}
                      render={({ field }) => (
                        <TextField
                          {...field}
                          onChange={(event) => {
                            field.onChange(event);
                            // Re-run the cross-field rule on the dependent field so its
                            // stale "required" error clears when this one is emptied.
                            void trigger('network_signal_name');
                          }}
                          label="Колірний код (CC)"
                          placeholder="0–15"
                          size="small"
                          type="number"
                          fullWidth
                          error={!!errors.network_cc}
                          helperText={errors.network_cc?.message}
                          disabled={busy}
                        />
                      )}
                    />
                  )}
                </Box>

                {!isEditMode && (
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                      gap: 2,
                    }}
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
                          disabled={busy}
                        />
                      )}
                    />
                    <Controller
                      name="network_name"
                      control={control}
                      render={({ field }) => (
                        <TextField
                          {...field}
                          onChange={(event) => {
                            field.onChange(event);
                            // Re-run the cross-field rule on the dependent field so its
                            // stale "required" error clears when this one is emptied.
                            void trigger('network_signal_name');
                          }}
                          label="Назва мережі"
                          size="small"
                          fullWidth
                          disabled={busy}
                        />
                      )}
                    />
                  </Box>
                )}

                <Controller
                  name="callsigns"
                  control={control}
                  render={({ field }) =>
                    isEditMode ? (
                      <Stack spacing={1}>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <TextField
                            fullWidth
                            label="Позивний"
                            size="small"
                            value={callsignDraft}
                            placeholder="Додати позивний"
                            disabled={busy}
                            onChange={(event) => setCallsignDraft(event.target.value.toUpperCase())}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                event.stopPropagation();
                                addCallsign();
                              }
                            }}
                          />
                          <Tooltip title="Додати позивний">
                            <span>
                              <IconButton
                                aria-label="Додати позивний"
                                onClick={addCallsign}
                                disabled={busy || normalizeCallsign(callsignDraft) === ''}
                              >
                                <AddIcon />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Stack>

                        <Stack direction="row" gap={1} flexWrap="wrap">
                          {(field.value ?? []).length === 0 ? (
                            <Typography variant="body2" color="text.secondary">
                              Позивні ще не додані
                            </Typography>
                          ) : (
                            (field.value ?? []).map((callsign: string) => (
                              <Chip
                                key={callsign}
                                label={callsign}
                                onDelete={busy ? undefined : () => removeCallsign(callsign)}
                                deleteIcon={<CloseIcon />}
                                color="primary"
                                variant="outlined"
                              />
                            ))
                          )}
                        </Stack>

                        {(() => {
                          const proposed = getProposedCallsigns(field.value ?? []);
                          return proposed.length > 0 ? (
                            <Stack spacing={0.75}>
                              <Typography variant="caption" color="text.secondary">
                                Запропоновані позивні
                              </Typography>
                              <Stack direction="row" gap={1} flexWrap="wrap">
                                {proposed.map((callsign) => (
                                  <Chip
                                    key={callsign}
                                    label={callsign}
                                    onClick={
                                      busy ? undefined : () => addSuggestedCallsign(callsign)
                                    }
                                    variant="filled"
                                  />
                                ))}
                              </Stack>
                            </Stack>
                          ) : null;
                        })()}
                      </Stack>
                    ) : (
                      <Autocomplete
                        multiple
                        freeSolo
                        autoSelect
                        options={[]}
                        value={field.value}
                        onChange={(_, newValue) =>
                          field.onChange(normalizeMultiValue(newValue as string[]))
                        }
                        renderInput={(params) => (
                          <TextField
                            {...params}
                            label="Позивні"
                            size="small"
                            placeholder="Розділяйте комою або Enter"
                          />
                        )}
                        disabled={busy}
                      />
                    )
                  }
                />
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
                      autoSelect
                      options={[]}
                      value={field.value}
                      onChange={(_, newValue) =>
                        field.onChange(normalizeMultiValue(newValue as string[]))
                      }
                      renderInput={(params) => (
                        <TextField {...params} label="Назви локацій" size="small" />
                      )}
                      disabled={busy}
                    />
                  )}
                />

                <Controller
                  name="coords"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      label="Координати (lat, lon або MGRS)"
                      fullWidth
                      error={!!errors.coords}
                      helperText={
                        errors.coords?.message ??
                        'Десяткові градуси (49.12345, 37.12345) або MGRS (37U DR 05997 22279)'
                      }
                      disabled={busy}
                      placeholder="49.12345, 37.12345"
                    />
                  )}
                />
              </FormSection>

              {/* Comment (last field in the list) */}
              <FormSection title="Коментар">
                <Controller
                  name="comment"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      label="Коментар"
                      size="small"
                      fullWidth
                      multiline
                      minRows={2}
                      disabled={busy}
                    />
                  )}
                />
              </FormSection>
            </Stack>
          </PowerForm>
        </Box>

        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
            p: 2.5,
            borderTop: '1px solid',
            borderColor: 'divider',
          }}
        >
          <Box sx={{ display: 'flex' }}>
            {isAdmin && !isEditMode && (
              <Button
                onClick={() => setShowAdvanced((prev) => !prev)}
                disabled={busy}
                color="inherit"
              >
                {showAdvanced ? 'Приховати розширені поля' : 'Розширені поля'}
              </Button>
            )}
          </Box>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button onClick={handleDrawerClose} disabled={busy}>
              Скасувати
            </Button>
            <Button
              type="submit"
              form="create-message-form"
              variant="contained"
              color="primary"
              disabled={busy}
              startIcon={busy && <CircularProgress size={20} color="inherit" />}
            >
              {busy ? 'Збереження...' : isEditMode ? 'Зберегти' : 'Створити'}
            </Button>
          </Box>
        </Box>
      </div>
    </Drawer>
  );
}
