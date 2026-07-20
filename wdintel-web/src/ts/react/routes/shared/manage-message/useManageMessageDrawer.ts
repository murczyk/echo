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
  type NetworkSearchResult,
} from '../../../services/api/direct-submit';
import { getUnitsByIds } from '../../../services/api/units';
import type { InboxMessage, SignalGroupEntry, Tag, User } from '../../../../../Bindings';
import { mapInboxMessageToForm } from './manage-message-drawer.mappers';
import { useRecentValues } from './useRecentValues';
import { hasRole } from '../../../utils/roles';
import { isPresent } from '../../../utils/misc';
import {
  makeMessageSchema,
  EMPTY_FORM_VALUES,
  normalizeCallsign,
  type MessageFormData,
} from './manage-message-drawer.schema';
import { MAX_MESSAGE_ATTACHMENTS, useMessageUppy } from './useMessageUppy';
import { useMessageParser } from './useMessageParser';
import { useMessageSubmit } from './useMessageSubmit';
import { isManageMessageSubmitEligible } from './manage-message-submit-eligibility';

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
  editSaveInFlight?: boolean;
  onSubmitEdit?: (id: number, message: InboxMessage) => void | Promise<void>;
};

export function useManageMessageDrawer({
  open,
  cyberEchoEnabled,
  currentUser,
  onClose,
  onCreated,
  onEditSuccess,
  editTarget = null,
  editSaveInFlight,
  onSubmitEdit,
}: UseManageMessageDrawerProps) {
  const isAdmin = hasRole(currentUser?.roles, 'Admin');
  const isEditMode = isPresent(editTarget);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [signalGroups, setSignalGroups] = useState<SignalGroupEntry[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { recentValues, addValues } = useRecentValues();

  const busy = submitting || (isEditMode && Boolean(editSaveInFlight));

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
    if (!open) return;
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
  }, [deviceNameInput, open]);

  useEffect(() => {
    if (!open) return;
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
  }, [postInput, open]);

  useEffect(() => {
    if (!open) return;
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
  }, [unitInput, open]);

  useEffect(() => {
    if (!open) return;
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
  }, [networkNameInput, open]);

  useEffect(() => {
    if (!open) return;
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
  }, [callsignInput, open]);

  useEffect(() => {
    if (!open) return;
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
  }, [freqInput, open]);

  const resolver = useMemo(() => zodResolver(makeMessageSchema(isEditMode)), [isEditMode]);

  const methods = useForm<MessageFormData>({
    resolver,
    mode: 'onChange',
    reValidateMode: 'onChange',
    defaultValues: EMPTY_FORM_VALUES,
  });

  const { control, formState, getValues, setValue, reset } = methods;
  const formValues = useWatch({ control });

  const retainedAttachmentCount = isEditMode
    ? (editTarget?.message.media.filter(
        (media) => !(formValues.deleted_media_ids ?? []).includes(media.id),
      ).length ?? 0)
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
    if (!open) return;
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [open, handlePaste]);

  const { parsing, handleParse } = useMessageParser(methods, busy, setErrorMsg);

  const canSubmit = useMemo(
    () =>
      isManageMessageSubmitEligible({
        busy,
        parsing,
        schemaValid: formState.isValid,
        isEditMode,
        groupsLoading,
        selectedGroupKey: formValues.signalGroupMasterKey ?? '',
        accessibleGroupKeys: signalGroups.map((group) => group.masterKey),
        text: formValues.text ?? '',
        fullBody: formValues.full_body ?? '',
        newAttachmentCount: uppyFiles.length,
        existingAttachmentIds: editTarget?.message.media.map((media) => media.id) ?? [],
        deletedAttachmentIds: formValues.deleted_media_ids ?? [],
        maxAttachmentCount: MAX_MESSAGE_ATTACHMENTS,
      }),
    [
      busy,
      editTarget,
      formState.isValid,
      formValues,
      groupsLoading,
      isEditMode,
      parsing,
      signalGroups,
      uppyFiles.length,
    ],
  );

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
        if (!isEditMode && getValues('signalGroupMasterKey')) {
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
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setDeviceNameInput('');
    setPostInput('');
    setUnitInput('');
    setNetworkNameInput('');
    setCallsignInput('');
    setFreqInput('');
    setShowAdvanced(false);
    setErrorMsg(null);
    setUnitLocked(false);
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
  }, [open, isEditMode, editTarget?.id, recentValues]);

  useEffect(() => {
    if (!open || !isEditMode || !editTarget) return;
    if ((getValues('tags') ?? []).length > 0) return;
    const seededTags = mapInboxMessageToForm(editTarget.message, tagsMap).tags;
    if (seededTags.length > 0) {
      setValue('tags', seededTags, { shouldDirty: false });
    }
  }, [open, isEditMode, editTarget?.id, tagsMap]);

  useEffect(() => {
    if (!open || !isEditMode || !editTarget) return;
    const name = editTarget.message.networkName?.trim();
    if (!name) return;
    // Resolve the named network to lock its unit(s), mirroring the create flow.
    searchNetworkNames(name)
      .then(async (results) => {
        const match = results.find((n) => n.name === name);
        const unitIds = match?.unit_ids ?? [];
        if (unitIds.length === 0) return;
        const units = await getUnitsByIds(unitIds);
        if (units.length > 0) {
          setValue('unit', units.map((u) => u.name).join(', '), {
            shouldDirty: false,
            shouldValidate: true,
          });
          setUnitLocked(true);
        }
      })
      .catch(console.error);
  }, [open, isEditMode, editTarget?.id]);

  const closeDrawerAfterSubmit = () => {
    uppy.cancelAll();
    reset();
    setDeviceNameInput('');
    setShowAdvanced(false);
    setErrorMsg(null);
    onClose();
  };

  const handleDrawerClose = () => {
    if (busy) return;
    closeDrawerAfterSubmit();
  };

  const getProposedCallsigns = (current: string[]): string[] => {
    const present = new Set(current.map(normalizeCallsign));
    return (editTarget?.message.callsignsAlg2 ?? [])
      .map(normalizeCallsign)
      .filter((item) => item.length > 0 && item.length <= 12 && !present.has(item))
      .filter((item, index, list) => list.indexOf(item) === index);
  };

  const addSuggestedCallsign = (callsign: string) => {
    const current = getValues('callsigns') ?? [];
    if (current.some((item) => normalizeCallsign(item) === callsign)) return;
    setValue('callsigns', [...current, callsign], { shouldDirty: true });
  };

  const { onSubmit } = useMessageSubmit({
    busy,
    isEditMode,
    editTarget,
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
    isAdmin,
    isEditMode,
    showAdvanced,
    setShowAdvanced,
    signalGroups,
    groupsLoading,
    busy,
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
    unitLocked,
    setUnitLocked,
    signalNameOptions,
    signalNameLoading,
    setSignalNameInput,
    callsignOptions,
    callsignLoading,
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
    getProposedCallsigns,
    addSuggestedCallsign,
    onSubmit,
    recentValues,
  };
}
