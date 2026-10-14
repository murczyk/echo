import { canUseRadioFeatures } from '../../../utils/roles';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import dayjs from 'dayjs';

import { useDutySettings } from '../../../hooks/use-duty-settings';

import {
  getUserSigintGroups,
  getGroupInfosBatch,
  getTagsForDisplay,
} from '../../../services/api/inbox-reference-data';
import {
  searchDeviceNames,
  searchPostNames,
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
import { useMessageUnitOptions } from './useMessageUnitOptions';
import { useMessageUnitSelection } from './useMessageUnitSelection';
import { useMessageNetworkUnits } from './useMessageNetworkUnits';
import {
  compatibleMessageUnitSelection,
  isMessageUnitSelectionValid,
} from './message-unit-selection';
import { isPresent } from '../../../utils/misc';
import { blurActiveElement } from '../../../utils/focus';
import {
  DO_NOT_SEND_GROUP_VALUE,
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
import type { MessageCardEtalonDisplayModel } from '../message-card/message-card.utils';
import { useBrowserBackOverlay } from '../../../hooks/use-browser-back-overlay';

export type QuickIntelReportSuggestionState =
  | { status: 'idle' | 'loading' | 'applied' }
  | { status: 'available'; suggestions: string[]; selectedIndex: number }
  | { status: 'error'; message: string };

export type ReportEditLoadState =
  | { status: 'idle' }
  | { status: 'loading'; reportId: number }
  | { status: 'error'; reportId: number; message: string };

export type ManageMessageIntentChange = {
  key: string;
  commit: () => void;
  focusTarget?: HTMLElement | null;
};

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
  reportSource?: {
    id: number;
    message: InboxMessage;
    senderName?: string | null;
    etalonDisplayModel?: MessageCardEtalonDisplayModel;
  } | null;
  editAsReport?: boolean;
  editTargetLoadState?: ReportEditLoadState;
  editSaveInFlight?: boolean;
  onSubmitEdit?: (id: number, message: InboxMessage) => void | Promise<void>;
  interactionActive?: boolean;
  keepOpenAfterCreate?: boolean;
  intentKey?: string;
  initialGroupMasterKey?: string | null;
};

export function useManageMessageDrawer({
  open,
  cyberEchoEnabled,
  currentUser,
  onClose,
  onCreated,
  onEditSuccess,
  editTarget = null,
  reportSource = null,
  editAsReport = false,
  editTargetLoadState = { status: 'idle' },
  editSaveInFlight,
  onSubmitEdit,
  interactionActive = true,
  keepOpenAfterCreate = false,
  intentKey,
  initialGroupMasterKey = null,
}: UseManageMessageDrawerProps) {
  const radioFeaturesAllowed = canUseRadioFeatures(currentUser?.roles);
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
  const [reportCopyError, setReportCopyError] = useState<string | null>(null);
  const [reportCopyRetryAttempt, setReportCopyRetryAttempt] = useState(0);
  const [reportCopyLoadedSourceId, setReportCopyLoadedSourceId] = useState<number | null>(null);
  const [originalReportText, setOriginalReportText] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [referenceDataError, setReferenceDataError] = useState<string | null>(null);
  const [referenceDataRetryAttempt, setReferenceDataRetryAttempt] = useState(0);
  const [quickSuggestion, setQuickSuggestion] = useState<QuickIntelReportSuggestionState>({
    status: 'idle',
  });
  const [quickSuggestionAttempt, setQuickSuggestionAttempt] = useState(0);
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false);
  const [createSucceeded, setCreateSucceeded] = useState(false);
  const pendingIntentChangeRef = useRef<ManageMessageIntentChange | null>(null);
  const editorRootRef = useRef<HTMLDivElement>(null);
  const editorOwnsInteractionRef = useRef(false);
  const reportCopyLoaded =
    isReportCreateMode && reportCopyLoadedSourceId === (reportSource?.id ?? null);

  const { recentValues, addValues, replaceUnitValues } = useRecentValues();
  const recentValuesRef = useRef(recentValues);
  recentValuesRef.current = recentValues;

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

  const [networkNameOptions, setNetworkNameOptions] = useState<NetworkSearchResult[]>([]);
  const [networkNameLoading, setNetworkNameLoading] = useState(false);
  const [networkNameInput, setNetworkNameInput] = useState('');
  const [networkUnitNamesById, setNetworkUnitNamesById] = useState<Record<number, string>>({});
  const [selectedNetwork, setSelectedNetworkState] = useState<NetworkSearchResult | null>(null);
  const networkSelectionRevisionRef = useRef(0);
  const selectedNetworkRef = useRef(selectedNetwork);
  const updateSelectedNetwork = useCallback((network: NetworkSearchResult | null) => {
    selectedNetworkRef.current = network;
    setSelectedNetworkState(network);
  }, []);
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

  const handleReferenceDataError = useCallback((description: string, error: unknown) => {
    console.error(description, error);
    setReferenceDataError('Не вдалося завантажити довідкові дані.');
  }, []);

  const retryReferenceData = useCallback(() => {
    setReferenceDataError(null);
    setReferenceDataRetryAttempt((attempt) => attempt + 1);
  }, []);

  const retryReportCopy = useCallback(() => {
    setReportCopyError(null);
    setReportCopyRetryAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => {
    if (!formReady || !cyberEchoEnabled) {
      setDeviceNameOptions([]);
      setDeviceNamesLoading(false);
      return;
    }
    let active = true;

    setDeviceNamesLoading(true);
    searchDeviceNames(deviceNameInput)
      .then((results) => {
        if (active) {
          setDeviceNameOptions(results.map((c) => c.name));
        }
      })
      .catch((error) => handleReferenceDataError('Failed to load device names', error))
      .finally(() => {
        if (active) setDeviceNamesLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    cyberEchoEnabled,
    deviceNameInput,
    formReady,
    handleReferenceDataError,
    referenceDataRetryAttempt,
  ]);

  useEffect(() => {
    if (!formReady || !radioFeaturesAllowed) return;
    let active = true;

    setPostLoading(true);
    searchPostNames(postInput)
      .then((results) => {
        if (active) {
          setPostOptions(results.map((p) => p.name));
        }
      })
      .catch((error) => handleReferenceDataError('Failed to load post names', error))
      .finally(() => {
        if (active) setPostLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    postInput,
    formReady,
    handleReferenceDataError,
    radioFeaturesAllowed,
    referenceDataRetryAttempt,
  ]);

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
      .catch((error) => handleReferenceDataError('Failed to load network names', error))
      .finally(() => {
        if (active) setNetworkNameLoading(false);
      });

    return () => {
      active = false;
    };
  }, [formReady, handleReferenceDataError, networkNameInput, referenceDataRetryAttempt]);

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
        setNetworkUnitNamesById((current) =>
          units.some((unit) => current[unit.id] !== unit.name)
            ? { ...current, ...Object.fromEntries(units.map((unit) => [unit.id, unit.name])) }
            : current,
        );
      })
      .catch((error) => handleReferenceDataError('Failed to load network units', error));

    return () => {
      active = false;
    };
  }, [
    formReady,
    handleReferenceDataError,
    networkNameOptions,
    networkUnitNamesById,
    referenceDataRetryAttempt,
  ]);

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
      .catch((error) => handleReferenceDataError('Failed to load callsigns', error))
      .finally(() => {
        if (active) setCallsignLoading(false);
      });

    return () => {
      active = false;
    };
  }, [callsignInput, formReady, handleReferenceDataError, referenceDataRetryAttempt]);

  useEffect(() => {
    if (!formReady || !radioFeaturesAllowed) return;
    let active = true;

    setFreqLoading(true);
    searchFreqs(freqInput)
      .then((results) => {
        if (active) {
          setFreqOptions(results.map((f) => f.name));
        }
      })
      .catch((error) => handleReferenceDataError('Failed to load frequencies', error))
      .finally(() => {
        if (active) setFreqLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    formReady,
    freqInput,
    handleReferenceDataError,
    radioFeaturesAllowed,
    referenceDataRetryAttempt,
  ]);

  const resolver = useMemo(
    () => zodResolver(makeMessageSchema(isEditMode, false, isReportMode, radioFeaturesAllowed)),
    [isEditMode, isReportMode, radioFeaturesAllowed],
  );

  const methods = useForm<MessageFormData>({
    resolver,
    mode: 'onChange',
    reValidateMode: 'onChange',
    defaultValues: EMPTY_FORM_VALUES,
  });

  const { control, formState, getValues, setValue, reset, resetField, watch } = methods;
  const explicitUnitSelectionRef = useRef(false);
  useEffect(() => {
    const subscription = watch((_values, { name, type }) => {
      if (name === 'unit' && type === 'change') explicitUnitSelectionRef.current = true;
    });
    return () => subscription.unsubscribe();
  }, [watch]);
  const formValues = useWatch({ control });
  const { unitOptions, unitLoading, unitAllowCreate, unitSearchResults, defaultRecentUnit } =
    useMessageUnitOptions({
      active: formReady,
      search: formValues.unit ?? '',
      recentNames: recentValues.unit,
      replaceRecentNames: replaceUnitValues,
      onError: handleReferenceDataError,
      retryAttempt: referenceDataRetryAttempt,
    });
  useMessageUnitSelection({
    active: formReady,
    isEditMode,
    methods,
    values: formValues,
    results: unitSearchResults,
  });
  const setSelectedNetwork = useMessageNetworkUnits({
    active: formReady,
    isEditMode,
    methods,
    selectedNetwork,
    networkSelectionRevisionRef,
    setSelectedNetwork: updateSelectedNetwork,
    setUnitLocked,
    setNetworkUnitNamesById,
    onError: handleReferenceDataError,
    retryAttempt: referenceDataRetryAttempt,
  });
  const defaultRecentUnitRef = useRef(defaultRecentUnit);
  const unitInteractedRef = useRef(false);
  const onUnitFocus = useCallback(() => {
    unitInteractedRef.current = true;
  }, []);
  defaultRecentUnitRef.current = defaultRecentUnit;
  const dirtyFields = formState.dirtyFields;
  const defaultValues = formState.defaultValues;
  useEffect(() => {
    if (!formReady || isEditMode || isReportMode || getValues('unit')) return;
    if (unitInteractedRef.current || methods.getFieldState('unit').isDirty) return;
    const unit = defaultRecentUnit;
    if (unit) {
      const originalDirtyDefaults = Object.fromEntries(
        Object.keys(dirtyFields).map((name) => [name, defaultValues?.[name]]),
      );
      const unitValues = { unit: unit.name, unitSelection: { id: unit.id, name: unit.name } };
      const currentValues = { ...getValues(), ...unitValues };
      // Update defaults before restoring values without emitting manual field changes.
      reset(
        { ...currentValues, ...originalDirtyDefaults, ...unitValues },
        { keepTouched: true, keepErrors: true },
      );
      reset(currentValues, { keepDefaultValues: true, keepTouched: true, keepErrors: true });
    }
  }, [
    formReady,
    getValues,
    isEditMode,
    isReportMode,
    methods,
    defaultRecentUnit,
    dirtyFields,
    defaultValues,
    reset,
  ]);
  const getInitialCreateFormValues = useCallback(
    (): MessageFormData => ({
      ...EMPTY_FORM_VALUES,
      date: dayjs(),
      time: null,
      signalGroupMasterKey: initialGroupMasterKey ? '' : (recentValuesRef.current.group[0] ?? ''),
      deviceName: cyberEchoEnabled ? (recentValuesRef.current.deviceName[0] ?? '') : '',
      unit: defaultRecentUnitRef.current?.name ?? '',
      unitSelection: defaultRecentUnitRef.current,
    }),
    [cyberEchoEnabled, initialGroupMasterKey],
  );

  const existingMedia: MessageMediaInfo[] = useMemo(() => {
    const rawList = isEditMode
      ? (editTarget?.message.media ?? [])
      : (reportSource?.message.media ?? []);
    return rawList.map((m) => {
      const raw = m as MessageMediaInfo & {
        file_name?: string | null;
        content_type?: string | null;
        size_bytes?: number | null;
        coordinate_status?: MessageMediaInfo['coordinateStatus'];
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
        positions: m.positions ?? [],
        transcription: m.transcription ?? (raw as any).transcription ?? null,
        ocr: m.ocr ?? (raw as any).ocr ?? null,
        summary: m.summary ?? (raw as any).summary ?? null,
        coordinateStatus: m.coordinateStatus ?? raw.coordinate_status ?? null,
        kmzConversionStatus: m.kmzConversionStatus ?? (raw as any).kmz_conversion_status ?? null,
      };
    });
  }, [isEditMode, editTarget?.message.media, reportSource?.message.media]);
  const retainedAttachmentIds =
    isEditMode || isReportCreateMode
      ? existingMedia
          .filter((media) => !(formValues.deleted_media_ids ?? []).includes(media.id))
          .map((media) => media.id)
      : [];
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
  } = useMessageUppy(busy, retainedAttachmentIds);
  const hasUnsavedChanges = formState.isDirty || uppyFiles.length > 0;

  useEffect(() => {
    if (!open || !hasUnsavedChanges) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges, open]);

  useEffect(() => {
    if (!open || !hasUnsavedChanges) return;
    const handleNavigationClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (
        !(target instanceof HTMLAnchorElement) ||
        editorRootRef.current?.contains(target) ||
        target.target === '_blank' ||
        target.hasAttribute('download')
      ) {
        return;
      }
      const destination = target.href;
      if (!destination || destination === window.location.href) return;
      event.preventDefault();
      pendingIntentChangeRef.current = {
        key: `navigate:${destination}`,
        focusTarget: target,
        commit: () => window.location.assign(destination),
      };
      setDiscardConfirmationOpen(true);
    };
    document.addEventListener('click', handleNavigationClick, true);
    return () => document.removeEventListener('click', handleNavigationClick, true);
  }, [hasUnsavedChanges, open]);

  useEffect(() => {
    if (!formReady || !interactionActive) {
      editorOwnsInteractionRef.current = false;
      return;
    }
    const updateOwnership = (event: Event) => {
      const root = editorRootRef.current;
      editorOwnsInteractionRef.current = Boolean(
        root && event.target instanceof Node && root.contains(event.target),
      );
    };
    const handleScopedPaste = (event: ClipboardEvent) => {
      const root = editorRootRef.current;
      if (!root) return;
      const targetInside = event.target instanceof Node && root.contains(event.target);
      const focusInside =
        document.activeElement instanceof Node && root.contains(document.activeElement);
      if (!targetInside && !focusInside && !editorOwnsInteractionRef.current) return;
      handlePaste(event);
    };
    document.addEventListener('pointerdown', updateOwnership, true);
    document.addEventListener('focusin', updateOwnership, true);
    window.addEventListener('paste', handleScopedPaste);
    return () => {
      document.removeEventListener('pointerdown', updateOwnership, true);
      document.removeEventListener('focusin', updateOwnership, true);
      window.removeEventListener('paste', handleScopedPaste);
    };
  }, [formReady, handlePaste, interactionActive]);

  const dutySettings = useDutySettings();
  const autoParseEnabled = dutySettings.messageAutoParseEnabled;
  const autoParseSettingsDisabled =
    dutySettings.loadInProgress || Boolean(dutySettings.loadError) || dutySettings.saveInProgress;
  const autoParseBeforeSaveRef = useRef<boolean | null>(null);
  const setMessageAutoParseEnabledRef = useRef(dutySettings.setMessageAutoParseEnabled);
  setMessageAutoParseEnabledRef.current = dutySettings.setMessageAutoParseEnabled;
  const handleToggleAutoParse = useCallback(
    (enabled: boolean) => {
      if (autoParseSettingsDisabled) return;
      autoParseBeforeSaveRef.current = dutySettings.messageAutoParseEnabled;
      dutySettings.setMessageAutoParseEnabled(enabled);
      dutySettings.scheduleSave({
        ...dutySettings,
        messageAutoParseEnabled: enabled,
      });
    },
    [autoParseSettingsDisabled, dutySettings],
  );

  useEffect(() => {
    if (dutySettings.saveError) {
      if (autoParseBeforeSaveRef.current !== null) {
        setMessageAutoParseEnabledRef.current(autoParseBeforeSaveRef.current);
        autoParseBeforeSaveRef.current = null;
      }
      setErrorMsg(dutySettings.saveError);
      return;
    }
    if (!dutySettings.saveInProgress) autoParseBeforeSaveRef.current = null;
  }, [dutySettings.saveError, dutySettings.saveInProgress]);

  const resetPristineCreateFields = useCallback(() => {
    reset({
      ...getInitialCreateFormValues(),
      signalGroupMasterKey: getValues('signalGroupMasterKey'),
    });
    setDeviceNameInput('');
    setPostInput('');
    setNetworkNameInput('');
    setCallsignInput('');
    setFreqInput('');
    setSelectedNetwork(null);
    setUnitLocked(false);
  }, [getInitialCreateFormValues, getValues, reset]);

  const {
    parsing,
    parseStatus,
    parserFeedback,
    debounceKey,
    handleBodyChange,
    handleParse,
    acceptParsedField,
  } = useMessageParser(methods, busy, setErrorMsg, {
    active: formReady,
    autoParseEnabled: autoParseEnabled && !dutySettings.loadInProgress && !dutySettings.loadError,
    isEditMode,
    isReportMode,
    radioFeaturesAllowed,
    onPristineSourceCleared: resetPristineCreateFields,
  });
  const handleAcceptParsedField = useCallback(
    (field: Parameters<typeof acceptParsedField>[0]) => {
      if (field === 'network_name' || (field === 'unit' && getValues('unitNetworkSelection'))) {
        setSelectedNetwork(null);
        setUnitLocked(false);
      }
      if (field === 'network_name') setNetworkNameInput('');
      acceptParsedField(field);
    },
    [acceptParsedField, getValues, setSelectedNetwork],
  );

  const canSubmit = useMemo(() => {
    const selectedGroupKey = formValues.signalGroupMasterKey ?? '';
    const reportDestinationMissing = isReportMode && !selectedGroupKey.trim();
    const parserBlocksSubmit =
      parsing || parseStatus === 'debouncing' || (autoParseEnabled && parseStatus === 'error');

    return isManageMessageSubmitEligible({
      busy: busy || (isReportCreateMode && !reportCopyLoaded),
      parsing: parserBlocksSubmit,
      schemaValid: formState.isValid || reportDestinationMissing,
      unitSelectionValid:
        isEditMode ||
        isMessageUnitSelectionValid(
          formValues.unit,
          formValues.unitSelection,
          formValues.unitNetworkSelection,
        ),
      isEditMode,
      allowMissingGroup: isReportMode,
      reportTextRequired: isReportMode,
      groupsLoading,
      selectedGroupKey,
      accessibleGroupKeys: [
        ...signalGroups.map((group) => group.masterKey),
        ...(isReportMode ? [DO_NOT_SEND_GROUP_VALUE] : []),
      ],
      text: formValues.text ?? '',
      fullBody: formValues.full_body ?? '',
      newAttachmentCount: uppyFiles.length,
      existingAttachmentIds: existingMedia.map((media) => media.id),
      deletedAttachmentIds: formValues.deleted_media_ids ?? [],
      replacedAttachmentIds: uppyFiles.flatMap((file) => {
        const mediaId = file.meta?.replaces_media_id;
        return typeof mediaId === 'string' ? [mediaId] : [];
      }),
      maxAttachmentCount: MAX_MESSAGE_ATTACHMENTS,
    });
  }, [
    busy,
    autoParseEnabled,
    editTarget,
    existingMedia,
    formState.isValid,
    formValues,
    groupsLoading,
    isEditMode,
    isReportCreateMode,
    isReportMode,
    parseStatus,
    parsing,
    reportCopyLoaded,
    signalGroups,
    uppyFiles,
  ]);

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
        if (!isEditMode && !isReportMode && initialGroupMasterKey) {
          if (available.some((group) => group.masterKey === initialGroupMasterKey)) {
            resetField('signalGroupMasterKey', { defaultValue: initialGroupMasterKey });
          } else {
            resetField('signalGroupMasterKey', { defaultValue: '' });
            setReferenceDataError('Обрана група більше недоступна.');
          }
          return;
        }
        // The MRU-seeded group is set synchronously on open, before this async list
        // arrives. If that remembered key is no longer available (account switch,
        // revoked access, deleted group), SystemSection renders it as an empty
        // selection while the value still passes required-validation — letting submit
        // or parse run against a group the user cannot actually see. Clear it so the
        // user must pick a valid group.
        if (!isEditMode && !isReportMode && getValues('signalGroupMasterKey')) {
          const seededKey = getValues('signalGroupMasterKey');
          if (!available.some((g) => g.masterKey === seededKey)) {
            resetField('signalGroupMasterKey', { defaultValue: '' });
          }
        }
      } catch (e) {
        handleReferenceDataError('Failed to load groups', e);
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
      .catch((error) => handleReferenceDataError('Failed to load tags', error));

    return () => {
      active = false;
    };
  }, [
    formReady,
    handleReferenceDataError,
    initialGroupMasterKey,
    intentKey,
    isEditMode,
    isReportMode,
    referenceDataRetryAttempt,
    resetField,
  ]);

  useEffect(() => {
    if (!formReady) return;
    unitInteractedRef.current = false;
    explicitUnitSelectionRef.current = false;
    setDeviceNameInput('');
    setPostInput('');
    setNetworkNameInput('');
    setCallsignInput('');
    setFreqInput('');
    setShowAdvanced(false);
    setErrorMsg(null);
    setReferenceDataError(null);
    setSelectedNetwork(null);
    setUnitLocked(false);
    setReportCopyLoadedSourceId(null);
    setReportCopyError(null);
    setOriginalReportText(reportParents.map(({ text }) => text).join('\n\n'));
    if (isEditMode && editTarget) {
      const metadata = editTarget.message.metadata ?? [];
      reset({
        ...mapInboxMessageToForm(editTarget.message, tagsMap),
        text: editTarget.message.noHeadersBody?.body ?? editTarget.message.text ?? '',
        signalGroupMasterKey:
          editTarget.message.groupMasterKey ?? (isReportMode ? DO_NOT_SEND_GROUP_VALUE : ''),
        deviceName: cyberEchoEnabled ? (editTarget.message.deviceName ?? '') : '',
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
        time: null,
      });
    } else {
      // Pre-fill the last-used values (MRU head) so repeated message creation
      // doesn't require re-entering the same group/device/unit each time.
      // Seed deviceName only when its field is actually rendered (cyberEchoEnabled);
      // otherwise SystemSection hides it while useMessageSubmit would still call
      // createDeviceName and send a stale device_name_id the user never chose.
      reset(getInitialCreateFormValues());
    }
  }, [
    formReady,
    isEditMode,
    isReportCreateMode,
    editAsReport,
    editTarget?.id,
    reportSource?.id,
    cyberEchoEnabled,
    getInitialCreateFormValues,
    intentKey,
  ]);

  useEffect(() => {
    if (!formReady || !isReportMode) return;
    if (reportParentIds.length === 0) {
      setOriginalReportText('');
      setCopyLoading(false);
      return;
    }
    let active = true;
    setReportCopyError(null);
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
          const copiedValues = mapDirectSubmitCopyToForm(payload);
          explicitUnitSelectionRef.current = Boolean(
            compatibleMessageUnitSelection(copiedValues.unit, copiedValues.unitSelection),
          );
          reset({
            ...copiedValues,
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
        setReportCopyError(formatDirectSubmitError(error, 'copy'));
      })
      .finally(() => {
        if (active) setCopyLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [
    formReady,
    isReportCreateMode,
    isReportMode,
    reportCopyRetryAttempt,
    reportParentIdsKey,
    reportSource?.id,
    reset,
  ]);

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
    if (!formReady) return;
    const source = isEditMode
      ? editTarget
      : isReportCreateMode && reportCopyLoaded
        ? reportSource
        : null;
    if (!source) return;
    if (selectedNetworkRef.current) return;
    if (!isEditMode && explicitUnitSelectionRef.current) return;
    let active = true;
    const initialNetworkSelectionRevision = networkSelectionRevisionRef.current;
    const initialNetworkName = getValues('network_name');
    const initialUnitName = getValues('unit');
    const canHydrate = () =>
      active &&
      networkSelectionRevisionRef.current === initialNetworkSelectionRevision &&
      getValues('network_name') === initialNetworkName &&
      getValues('unit') === initialUnitName &&
      !getValues('unitNetworkSelection') &&
      (isEditMode || !explicitUnitSelectionRef.current);
    const hydrateNetwork = async () => {
      const linkedNetworkIds = source.message.networkIds ?? [];
      const freeformName = source.message.networkName?.trim();

      if (linkedNetworkIds.length > 0) {
        const networks = await getNetworksByIds(linkedNetworkIds);
        const network =
          linkedNetworkIds
            .map((networkId) => networks.find(({ id }) => id === networkId))
            .find(isPresent) ?? networks[0];
        if (!network || !canHydrate()) return;
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
        if (!canHydrate()) return;
        const match = results.find((network) => network.name === freeformName);
        if (match) setSelectedNetwork(match);
      }
    };

    hydrateNetwork().catch((error) => {
      if (canHydrate()) handleReferenceDataError('Failed to load message network', error);
    });
    return () => {
      active = false;
    };
  }, [
    formReady,
    isEditMode,
    editTarget?.id,
    isReportCreateMode,
    reportCopyLoaded,
    reportSource?.id,
    getValues,
    setSelectedNetwork,
    setValue,
    handleReferenceDataError,
    referenceDataRetryAttempt,
  ]);

  const finalizeDrawerClose = () => {
    blurActiveElement();
    uppy.cancelAll();
    reset();
    setDiscardConfirmationOpen(false);
    setDeviceNameInput('');
    setShowAdvanced(false);
    setErrorMsg(null);
    setReferenceDataError(null);
    setReportCopyError(null);
    pendingIntentChangeRef.current = null;
    onClose();
  };

  const handleBrowserBack = () => {
    if (saving) return false;
    if (hasUnsavedChanges) {
      pendingIntentChangeRef.current = null;
      setDiscardConfirmationOpen(true);
      return false;
    }
    finalizeDrawerClose();
    return true;
  };

  const requestDrawerClose = useBrowserBackOverlay({
    open,
    onClose: finalizeDrawerClose,
    onBrowserBack: handleBrowserBack,
  });

  const closeDrawerAfterSubmit = () => requestDrawerClose();

  const handleCreateSuccess = useCallback(
    (submittedValues: MessageFormData) => {
      if (!keepOpenAfterCreate) {
        closeDrawerAfterSubmit();
        return;
      }
      uppy.cancelAll();
      reset({
        ...getInitialCreateFormValues(),
        signalGroupMasterKey: submittedValues.signalGroupMasterKey ?? '',
        deviceName: cyberEchoEnabled ? (submittedValues.deviceName ?? '') : '',
        unit: submittedValues.unit ?? '',
        unitSelection: submittedValues.unitSelection,
        unitNetworkSelection: submittedValues.unitNetworkSelection,
        network_name: submittedValues.unitNetworkSelection ? submittedValues.network_name : '',
        network_signal_name: submittedValues.unitNetworkSelection
          ? submittedValues.network_signal_name
          : '',
      });
      setDeviceNameInput('');
      setPostInput('');
      setNetworkNameInput('');
      setCallsignInput('');
      setFreqInput('');
      if (!submittedValues.unitNetworkSelection) {
        setSelectedNetwork(null);
        setUnitLocked(false);
      }
      setShowAdvanced(false);
      setErrorMsg(null);
      setCreateSucceeded(true);
    },
    [cyberEchoEnabled, getInitialCreateFormValues, keepOpenAfterCreate, reset, uppy],
  );

  useEffect(() => {
    if (formState.isDirty) setCreateSucceeded(false);
  }, [formState.isDirty]);

  useEffect(() => {
    setCreateSucceeded(false);
  }, [intentKey, open]);

  const handleDrawerClose = () => {
    if (saving) return;
    if (hasUnsavedChanges) {
      pendingIntentChangeRef.current = null;
      setDiscardConfirmationOpen(true);
      return;
    }
    requestDrawerClose();
  };

  const requestIntentChange = useCallback(
    (change: ManageMessageIntentChange) => {
      if (saving) return;
      if (!hasUnsavedChanges) {
        change.commit();
        return;
      }
      pendingIntentChangeRef.current = change;
      setDiscardConfirmationOpen(true);
    },
    [hasUnsavedChanges, saving],
  );

  const cancelDiscard = () => {
    pendingIntentChangeRef.current = null;
    setDiscardConfirmationOpen(false);
  };

  const confirmDiscard = () => {
    setDiscardConfirmationOpen(false);
    const pendingIntentChange = pendingIntentChangeRef.current;
    pendingIntentChangeRef.current = null;
    if (pendingIntentChange) {
      uppy.cancelAll();
      reset();
      setErrorMsg(null);
      pendingIntentChange.commit();
      return;
    }
    requestDrawerClose();
  };

  const { onSubmit } = useMessageSubmit({
    busy,
    radioFeaturesAllowed,
    cyberEchoEnabled,
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
    handleCreateSuccess,
  });

  return {
    radioFeaturesAllowed,
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
    parseStatus,
    parserFeedback,
    debounceKey,
    handleBodyChange,
    errorMsg,
    setErrorMsg,
    reportCopyError,
    retryReportCopy,
    referenceDataError,
    retryReferenceData,
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
    unitAllowCreate,
    onUnitFocus,
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
    acceptParsedField: handleAcceptParsedField,
    autoParseEnabled,
    autoParseSettingsDisabled,
    autoParseSettingsLoadError: dutySettings.loadError,
    retryAutoParseSettings: dutySettings.retryLoad,
    handleToggleAutoParse,
    handleDrawerClose,
    closeDrawerWithoutConfirmation: closeDrawerAfterSubmit,
    requestIntentChange,
    editorRootRef,
    discardConfirmationOpen,
    cancelDiscard,
    confirmDiscard,
    onSubmit,
    recentValues,
    createSucceeded,
  };
}
