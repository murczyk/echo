import { useState, useEffect, useMemo } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import dayjs from 'dayjs';

import {
  getUserSigintGroups,
  getGroupInfosBatch,
  getTagsForDisplay,
} from '../../../services/api/inbox-reference-data';
import {
  searchDeviceNames,
  searchPostNames,
  searchUnitNames,
  searchNetworkNames,
  searchSignalNames,
  searchCallsignNames,
  searchFreqs,
  copyDirectSubmit,
  formatDirectSubmitError,
  type NetworkSearchResult,
} from '../../../services/api/direct-submit';
import { getNetworksByIds } from '../../../services/api/networks';
import { getUnitsByIds } from '../../../services/api/units';
import type {
  InboxMessage,
  MessageMediaInfo,
  SignalGroupEntry,
  Tag,
  User,
} from '../../../../../Bindings';
import { mapDirectSubmitCopyToForm, mapInboxMessageToForm } from './manage-message-drawer.mappers';
import { useRecentValues } from './useRecentValues';
import { isPresent } from '../../../utils/misc';
import { blurActiveElement } from '../../../utils/focus';
import {
  makeMessageSchema,
  EMPTY_FORM_VALUES,
  type MessageFormData,
} from './manage-message-drawer.schema';
import { MAX_MESSAGE_ATTACHMENTS, useMessageUppy } from './useMessageUppy';
import { useMessageParser } from './useMessageParser';
import { useMessageSubmit } from './useMessageSubmit';
import { isManageMessageSubmitEligible } from './manage-message-submit-eligibility';
import { getAccessibleParentMessages, summarizeIntelligenceMessage } from '../intelligence-reports';
import { quickIntelReportSuggestion } from '../../../services/api/ai-intel-report';
import { isAbortError } from '../../../services/api/client';

export type QuickIntelReportSuggestionState =
  | { status: 'idle' | 'loading' | 'applied' }
  | { status: 'available'; suggestions: string[]; selectedIndex: number }
  | { status: 'error'; message: string };

export type ReportEditLoadState =
  | { status: 'idle' }
  | { status: 'loading'; reportId: number }
  | { status: 'error'; reportId: number; message: string };

export type UseManageMessageDrawerProps = {
  open: boolean;
  cyberEchoEnabled: boolean;
  currentUser: User | null;
  onClose: () => void;
  onCreated?: (
    result: import('../../../services/api/direct-submit').DirectSubmitResponse,
  ) => void | Promise<void>;
  onEditSuccess?: (
    result: import('../../../services/api/direct-submit').DirectSubmitResponse,
  ) => void | Promise<void>;
  editTarget?: { id: number; message: InboxMessage } | null;
  reportSource?: { id: number; message: InboxMessage } | null;
  editAsReport?: boolean;
  editTargetLoadState?: ReportEditLoadState;
  editSaveInFlight?: boolean;
  onSubmitEdit?: (id: number, message: InboxMessage) => void | Promise<void>;
};

export function useManageMessageDrawer({
  open,
  cyberEchoEnabled,
  onClose,
  onCreated,
  onEditSuccess,
  editTarget = null,
  reportSource = null,
  editAsReport = false,
  editTargetLoadState = { status: 'idle' },
  editSaveInFlight,
  onSubmitEdit,
}: UseManageMessageDrawerProps) {
  const isEditMode = isPresent(editTarget);
  const isReportCreateMode = isPresent(reportSource) && !isEditMode;
  const isReportEditMode = (isEditMode && editAsReport) || editTargetLoadState.status !== 'idle';
  const reportParents = isPresent(reportSource)
    ? [summarizeIntelligenceMessage(reportSource.id, reportSource.message)]
    : isReportEditMode && isPresent(editTarget)
      ? getAccessibleParentMessages(editTarget.message)
      : [];
  const reportParentIds = reportParents.map(({ id }) => id);
  const reportParentIdsKey = reportParentIds.join(',');
  const isReportMode = isReportCreateMode || isReportEditMode;
  const formReady = open && editTargetLoadState.status === 'idle';
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [signalGroups, setSignalGroups] = useState<SignalGroupEntry[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [copyLoading, setCopyLoading] = useState(false);
  const [reportCopyLoadedSourceId, setReportCopyLoadedSourceId] = useState<number | null>(null);
  const [originalReportText, setOriginalReportText] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [quickSuggestion, setQuickSuggestion] = useState<QuickIntelReportSuggestionState>({
    status: 'idle',
  });
  const [quickSuggestionAttempt, setQuickSuggestionAttempt] = useState(0);
  const reportCopyLoaded =
    isReportCreateMode && reportCopyLoadedSourceId === (reportSource?.id ?? null);

  const { recentValues, addValues } = useRecentValues();

  const saving = submitting || (isEditMode && Boolean(editSaveInFlight));
  const formLoading = copyLoading;
  const busy = saving || formLoading;

  const [tagOptions, setTagOptions] = useState<string[]>([]);
  const [tagsMap, setTagsMap] = useState<Record<number, Tag>>({});
  const [tagsLoaded, setTagsLoaded] = useState(false);

  const [deviceNameOptions, setDeviceNameOptions] = useState<string[]>([]);
  const [deviceNamesLoading, setDeviceNamesLoading] = useState(false);
  const [deviceNameInput, setDeviceNameInput] = useState('');

  const [postOptions, setPostOptions] = useState<string[]>([]);
  const [postLoading, setPostLoading] = useState(false);
  const [postInput, setPostInput] = useState('');

  const [unitOptions, setUnitOptions] = useState<string[]>([]);
  const [unitLoading, setUnitLoading] = useState(false);
  const [unitInput, setUnitInput] = useState('');

  const [networkNameOptions, setNetworkNameOptions] = useState<NetworkSearchResult[]>([]);
  const [networkNameLoading, setNetworkNameLoading] = useState(false);
  const [networkNameInput, setNetworkNameInput] = useState('');
  const [networkUnitNamesById, setNetworkUnitNamesById] = useState<Record<number, string>>({});
  const [selectedNetwork, setSelectedNetwork] = useState<NetworkSearchResult | null>(null);
  const [unitLocked, setUnitLocked] = useState(false);

  const signalNameOptions = ['DMR'];
  const signalNameLoading = false;
  const setSignalNameInput = () => {};

  const [callsignOptions, setCallsignOptions] = useState<string[]>([]);
  const [callsignLoading, setCallsignLoading] = useState(false);
  const [callsignInput, setCallsignInput] = useState('');

  const [freqOptions, setFreqOptions] = useState<string[]>([]);
  const [freqLoading, setFreqLoading] = useState(false);
  const [freqInput, setFreqInput] = useState('');

  useEffect(() => {
    if (!formReady) return;
    let active = true;

    setDeviceNamesLoading(true);
    searchDeviceNames(deviceNameInput)
      .then((results) => {
        if (active) {
          setDeviceNameOptions(results.map((c) => c.name));
        }
      })
      .catch(console.error)
      .finally(() => {
        if (active) setDeviceNamesLoading(false);
      });

    return () => {
      active = false;
    };
  }, [deviceNameInput, formReady]);

  useEffect(() => {
    if (!formReady) return;
    let active = true;

    setPostLoading(true);
    searchPostNames(postInput)
      .then((results) => {
        if (active) {
          setPostOptions(results.map((p) => p.name));
        }
      })
      .catch(console.error)
      .finally(() => {
        if (active) setPostLoading(false);
      });

    return () => {
      active = false;
    };
  }, [postInput, formReady]);

  useEffect(() => {
    if (!formReady) return;
    let active = true;

    setUnitLoading(true);
    searchUnitNames(unitInput)
      .then((results) => {
        if (active) {
          setUnitOptions(results.map((u) => u.name));
        }
      })
      .catch(console.error)
      .finally(() => {
        if (active) setUnitLoading(false);
      });

    return () => {
      active = false;
    };
  }, [unitInput, formReady]);

  useEffect(() => {
    if (!formReady) return;
    let active = true;

    setNetworkNameLoading(true);
    searchNetworkNames(networkNameInput)
      .then((results) => {
        if (active) {
          setNetworkNameOptions(results);
        }
      })
      .catch(console.error)
      .finally(() => {
        if (active) setNetworkNameLoading(false);
      });

    return () => {
      active = false;
    };
  }, [networkNameInput, formReady]);

  useEffect(() => {
    if (!formReady) return;
    const unitIds = Array.from(
      new Set(networkNameOptions.flatMap((network) => network.unit_ids ?? [])),
    ).filter((unitId) => networkUnitNamesById[unitId] == null);
    if (unitIds.length === 0) return;
    let active = true;

    getUnitsByIds(unitIds)
      .then((units) => {
        if (!active) return;
        setNetworkUnitNamesById((current) => ({
          ...current,
          ...Object.fromEntries(units.map((unit) => [unit.id, unit.name])),
        }));
      })
      .catch(console.error);

    return () => {
      active = false;
    };
  }, [networkNameOptions, networkUnitNamesById, formReady]);

  useEffect(() => {
    if (!formReady) return;
    let active = true;

    setCallsignLoading(true);
    searchCallsignNames(callsignInput)
      .then((results) => {
        if (active) {
          setCallsignOptions(results.map((c) => c.name));
        }
      })
      .catch(console.error)
      .finally(() => {
        if (active) setCallsignLoading(false);
      });

    return () => {
      active = false;
    };
  }, [callsignInput, formReady]);

  useEffect(() => {
    if (!formReady) return;
    let active = true;

    setFreqLoading(true);
    searchFreqs(freqInput)
      .then((results) => {
        if (active) {
          setFreqOptions(results.map((f) => f.name));
        }
      })
      .catch(console.error)
      .finally(() => {
        if (active) setFreqLoading(false);
      });

    return () => {
      active = false;
    };
  }, [freqInput, formReady]);

  const resolver = useMemo(
    () => zodResolver(makeMessageSchema(isEditMode, isReportMode, isReportMode)),
    [isEditMode, isReportMode],
  );

  const methods = useForm<MessageFormData>({
    resolver,
    mode: 'onChange',
    reValidateMode: 'onChange',
    defaultValues: EMPTY_FORM_VALUES,
  });

  const { control, formState, getValues, setValue, reset } = methods;
  const formValues = useWatch({ control });

  const existingMedia: MessageMediaInfo[] = useMemo(() => {
    const rawList = isEditMode
      ? (editTarget?.message.media ?? [])
      : (reportSource?.message.media ?? []);
    return rawList.map((m) => {
      const raw = m as MessageMediaInfo & {
        file_name?: string | null;
        content_type?: string | null;
        size_bytes?: number | null;
      };
      const id = String(m.id ?? (raw as any).id ?? '');
      const fileName = m.fileName ?? raw.file_name ?? null;
      const contentType = m.contentType ?? raw.content_type ?? '';
      const sizeBytes = m.sizeBytes ?? raw.size_bytes ?? 0;
      const href = m.href || (id ? `/api/messenger/media/${id}` : '');
      return {
        id,
        fileName,
        contentType,
        sizeBytes,
        href,
        transcription: m.transcription ?? (raw as any).transcription ?? null,
        ocr: m.ocr ?? (raw as any).ocr ?? null,
        summary: m.summary ?? (raw as any).summary ?? null,
      };
    });
  }, [isEditMode, editTarget?.message.media, reportSource?.message.media]);
  const retainedAttachmentCount =
    isEditMode || isReportCreateMode
      ? (existingMedia.filter((media) => !(formValues.deleted_media_ids ?? []).includes(media.id))
          .length ?? 0)
      : 0;
  const {
    uppy,
    uppyFiles,
    fileInputRef,
    handleFileSelect,
    handleDrop,
    handlePaste,
    handleDropzoneKeyDown,
    attachmentErrorMsg,
    setAttachmentErrorMsg,
  } = useMessageUppy(busy, retainedAttachmentCount);

  useEffect(() => {
    if (!formReady) return;
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [formReady, handlePaste]);

  const { parsing, handleParse } = useMessageParser(methods, busy, setErrorMsg);

  const canSubmit = useMemo(
    () =>
      isManageMessageSubmitEligible({
        busy: busy || (isReportCreateMode && !reportCopyLoaded),
        parsing,
        schemaValid: formState.isValid,
        isEditMode,
        groupOptional: isReportMode,
        reportTextRequired: isReportMode,
        groupsLoading,
        selectedGroupKey: formValues.signalGroupMasterKey ?? '',
        accessibleGroupKeys: signalGroups.map((group) => group.masterKey),
        text: formValues.text ?? '',
        fullBody: formValues.full_body ?? '',
        newAttachmentCount: uppyFiles.length,
        existingAttachmentIds: existingMedia.map((media) => media.id),
        deletedAttachmentIds: formValues.deleted_media_ids ?? [],
        maxAttachmentCount: MAX_MESSAGE_ATTACHMENTS,
      }),
    [
      busy,
      editTarget,
      existingMedia,
      formState.isValid,
      formValues,
      groupsLoading,
      isEditMode,
      isReportCreateMode,
      isReportMode,
      parsing,
      reportCopyLoaded,
      signalGroups,
      uppyFiles.length,
    ],
  );

  useEffect(() => {
    if (!formReady) return;
    let active = true;

    const fetchGroups = async () => {
      setGroupsLoading(true);
      try {
        const keys = await getUserSigintGroups(null);
        if (!active) return;
        const infos = await getGroupInfosBatch(keys);
        if (!active) return;
        const available = infos.filter((g) => {
          const adminData = g.adminData as any;
          return !adminData?.deleted;
        });
        setSignalGroups(available);
        // The MRU-seeded group is set synchronously on open, before this async list
        // arrives. If that remembered key is no longer available (account switch,
        // revoked access, deleted group), SystemSection renders it as an empty
        // selection while the value still passes required-validation — letting submit
        // or parse run against a group the user cannot actually see. Clear it so the
        // user must pick a valid group.
        if (!isEditMode && !isReportMode && getValues('signalGroupMasterKey')) {
          const seededKey = getValues('signalGroupMasterKey');
          if (!available.some((g) => g.masterKey === seededKey)) {
            setValue('signalGroupMasterKey', '', { shouldValidate: true });
          }
        }
      } catch (e) {
        console.error('Failed to load groups', e);
      } finally {
        if (active) setGroupsLoading(false);
      }
    };

    fetchGroups();

    setTagsLoaded(false);
    getTagsForDisplay()
      .then(({ tagsMap, tagsOrder }) => {
        if (!active) return;
        setTagsMap(tagsMap);
        setTagsLoaded(true);
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
  }, [formReady]);

  useEffect(() => {
    if (!formReady) return;
    setDeviceNameInput('');
    setPostInput('');
    setUnitInput('');
    setNetworkNameInput('');
    setCallsignInput('');
    setFreqInput('');
    setShowAdvanced(false);
    setErrorMsg(null);
    setSelectedNetwork(null);
    setUnitLocked(false);
    setReportCopyLoadedSourceId(null);
    setOriginalReportText(reportParents.map(({ text }) => text).join('\n\n'));
    if (isEditMode && editTarget) {
      const metadata = editTarget.message.metadata ?? [];
      reset({
        ...mapInboxMessageToForm(editTarget.message, tagsMap),
        text: editTarget.message.noHeadersBody?.body ?? editTarget.message.text ?? '',
        signalGroupMasterKey: editTarget.message.groupMasterKey ?? '',
        deviceName: editTarget.message.deviceName ?? '',
        network_signal_name:
          metadata.length || editTarget.message.networkIds?.length || editTarget.message.networkName
            ? 'DMR'
            : '',
        network_name: editTarget.message.networkName ?? '',
        dmr: metadata.map((item) => ({
          cc: item.colorCode ?? '',
          sender_id: item.senderId ?? '',
          sender_name: item.senderName ?? '',
          call_group_id: item.callGroupId ?? '',
          call_group_name: item.callGroupName ?? '',
          hash_id: item.hashId ?? '',
        })),
      });
    } else if (isReportCreateMode && reportSource) {
      reset({
        ...EMPTY_FORM_VALUES,
        date: dayjs(),
        time: dayjs(),
      });
    } else {
      // Pre-fill the last-used values (MRU head) so repeated message creation
      // doesn't require re-entering the same group/device/unit each time.
      // Seed deviceName only when its field is actually rendered (cyberEchoEnabled);
      // otherwise SystemSection hides it while useMessageSubmit would still call
      // createDeviceName and send a stale device_name_id the user never chose.
      reset({
        ...EMPTY_FORM_VALUES,
        date: dayjs(),
        time: dayjs(),
        signalGroupMasterKey: recentValues.group[0] ?? '',
        deviceName: cyberEchoEnabled ? (recentValues.deviceName[0] ?? '') : '',
        unit: recentValues.unit[0] ?? '',
      });
    }
  }, [
    formReady,
    isEditMode,
    isReportCreateMode,
    editAsReport,
    editTarget?.id,
    reportSource?.id,
    recentValues,
  ]);

  useEffect(() => {
    if (!formReady || !isReportMode) return;
    if (reportParentIds.length === 0) {
      setOriginalReportText('');
      setCopyLoading(false);
      return;
    }
    let active = true;
    setCopyLoading(true);
    const controller = new AbortController();
    copyDirectSubmit(reportParentIds, { signal: controller.signal })
      .then(({ payloads }) => {
        if (!active) return;
        setOriginalReportText(
          payloads
            .map(
              (payload, index) =>
                payload.full_body ?? payload.text ?? reportParents[index]?.text ?? '',
            )
            .join('\n\n'),
        );
        const payload = payloads[0];
        if (isReportCreateMode && payload) {
          reset({
            ...mapDirectSubmitCopyToForm(payload),
            full_body: '',
            text: '',
            comment: '',
            signalGroupMasterKey: '',
            deviceName: '',
          });
          setReportCopyLoadedSourceId(reportSource.id);
        }
      })
      .catch((error) => {
        if (!active) return;
        setErrorMsg(formatDirectSubmitError(error, 'copy'));
      })
      .finally(() => {
        if (active) setCopyLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [formReady, isReportCreateMode, isReportMode, reportParentIdsKey, reportSource?.id, reset]);

  useEffect(() => {
    if (!formReady || !isReportCreateMode || !reportCopyLoaded || !reportSource) {
      setQuickSuggestion({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    let active = true;
    setQuickSuggestion({ status: 'loading' });
    quickIntelReportSuggestion(reportSource.id, { signal: controller.signal })
      .then((response) => {
        if (!active) return;
        if (!response) {
          setQuickSuggestion({ status: 'idle' });
          return;
        }
        const suggestions = response.suggestions
          .map((suggestion) => suggestion.trim())
          .filter(Boolean);
        if (suggestions.length === 0) {
          setQuickSuggestion({
            status: 'error',
            message: 'ШІ повернув порожню пропозицію.',
          });
          return;
        }
        setQuickSuggestion({ status: 'available', suggestions, selectedIndex: 0 });
      })
      .catch((requestError) => {
        if (!active || isAbortError(requestError)) return;
        setQuickSuggestion({
          status: 'error',
          message: 'Не вдалося сформувати пропозицію розвіддонесення.',
        });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [isReportCreateMode, formReady, quickSuggestionAttempt, reportCopyLoaded, reportSource?.id]);

  const applyQuickSuggestion = () => {
    if (quickSuggestion.status !== 'available') return;
    setValue('full_body', quickSuggestion.suggestions[quickSuggestion.selectedIndex], {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
    setQuickSuggestion({ status: 'applied' });
  };

  const selectAdjacentQuickSuggestion = (offset: number) => {
    setQuickSuggestion((current) => {
      if (current.status !== 'available' || current.suggestions.length < 2) return current;
      const selectedIndex =
        (current.selectedIndex + offset + current.suggestions.length) % current.suggestions.length;
      return { ...current, selectedIndex };
    });
  };

  const retryQuickSuggestion = () => {
    setQuickSuggestionAttempt((attempt) => attempt + 1);
  };

  useEffect(() => {
    if (!formReady || !isEditMode || !editTarget) return;
    if ((getValues('tags') ?? []).length > 0) return;
    const seededTags = mapInboxMessageToForm(editTarget.message, tagsMap).tags;
    if (seededTags.length > 0) {
      setValue('tags', seededTags, { shouldDirty: false });
    }
  }, [formReady, isEditMode, editTarget?.id, tagsMap]);

  useEffect(() => {
    if (!formReady || !isEditMode || !editTarget) return;
    let active = true;
    const hydrateNetwork = async () => {
      const linkedNetworkIds = editTarget.message.networkIds ?? [];
      const freeformName = editTarget.message.networkName?.trim();
      let networkName = freeformName;
      let unitIds: number[] = [];

      if (linkedNetworkIds.length > 0) {
        const networks = await getNetworksByIds(linkedNetworkIds);
        const network =
          linkedNetworkIds
            .map((networkId) => networks.find(({ id }) => id === networkId))
            .find(isPresent) ?? networks[0];
        if (!network || !active) return;
        networkName = network.name;
        unitIds = network.unitIds ?? [];
        setSelectedNetwork({
          id: network.id,
          name: network.name,
          unit_ids: network.unitIds,
          freqs: network.freqs,
        });
        setValue('network_name', network.name, {
          shouldDirty: false,
          shouldValidate: true,
        });
      } else if (freeformName) {
        const results = await searchNetworkNames(freeformName);
        const match = results.find((network) => network.name === freeformName);
        unitIds = match?.unit_ids ?? [];
        if (match) setSelectedNetwork(match);
      }

      if (!active || !networkName) return;
      if (unitIds.length === 0) return;
      const units = await getUnitsByIds(unitIds);
      if (!active) return;
      if (units.length > 0) {
        setNetworkUnitNamesById((current) => ({
          ...current,
          ...Object.fromEntries(units.map((unit) => [unit.id, unit.name])),
        }));
        setValue('unit', units.map((unit) => unit.name).join(', '), {
          shouldDirty: false,
          shouldValidate: true,
        });
        setUnitLocked(true);
      }
    };

    hydrateNetwork().catch(console.error);
    return () => {
      active = false;
    };
  }, [formReady, isEditMode, editTarget?.id]);

  const closeDrawerAfterSubmit = () => {
    blurActiveElement();
    uppy.cancelAll();
    reset();
    setDeviceNameInput('');
    setShowAdvanced(false);
    setErrorMsg(null);
    onClose();
  };

  const handleDrawerClose = () => {
    if (saving) return;
    closeDrawerAfterSubmit();
  };

  const { onSubmit } = useMessageSubmit({
    busy,
    isEditMode,
    isReportMode,
    isReportCreateMode,
    editTarget,
    reportSource,
    existingMedia,
    onSubmitEdit,
    tagsLoaded,
    setSubmitting,
    setErrorMsg,
    uppy,
    addValues,
    onCreated,
    onEditSuccess,
    handleDrawerCloseAfterSubmit: closeDrawerAfterSubmit,
  });

  return {
    isEditMode,
    isReportMode,
    isReportCreateMode,
    originalReportText,
    quickSuggestion,
    applyQuickSuggestion,
    selectAdjacentQuickSuggestion,
    retryQuickSuggestion,
    existingMedia,
    showAdvanced,
    setShowAdvanced,
    signalGroups,
    groupsLoading,
    busy,
    formDisabled: busy,
    saving,
    parsing,
    errorMsg,
    setErrorMsg,
    tagOptions,
    tagsMap,
    setTagsMap,
    deviceNameOptions,
    deviceNamesLoading,
    deviceNameInput,
    setDeviceNameInput,
    postOptions,
    postLoading,
    setPostInput,
    unitOptions,
    unitLoading,
    setUnitInput,
    networkNameOptions,
    networkNameLoading,
    setNetworkNameInput,
    networkUnitNamesById,
    selectedNetwork,
    setSelectedNetwork,
    unitLocked,
    setUnitLocked,
    signalNameOptions,
    signalNameLoading,
    setSignalNameInput,
    callsignOptions,
    callsignLoading,
    callsignInput,
    setCallsignInput,
    freqOptions,
    freqLoading,
    setFreqInput,
    uppy,
    uppyFiles,
    fileInputRef,
    handleFileSelect,
    handleDrop,
    handlePaste,
    handleDropzoneKeyDown,
    attachmentErrorMsg,
    setAttachmentErrorMsg,
    methods,
    canSubmit,
    handleParse,
    handleDrawerClose,
    onSubmit,
    recentValues,
  };
}
