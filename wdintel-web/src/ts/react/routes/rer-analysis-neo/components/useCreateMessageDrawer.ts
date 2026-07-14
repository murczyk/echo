import { useState, useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import dayjs from 'dayjs';

import {
  getUserSigintGroups,
  getGroupInfosBatch,
  getTagsForDisplay,
} from '../../../services/api/inbox-reference-data';
import {
  searchComputerNames,
  searchPostNames,
  searchUnitNames,
  searchNetworkNames,
  searchSignalNames,
  searchCallsignNames,
  searchFreqs,
} from '../../../services/api/direct-submit';
import type { InboxMessage, SignalGroupEntry, Tag, User } from '../../../../../Bindings';
import { mapInboxMessageToForm } from './create-message-drawer.mappers';
import { useRecentValues } from './useRecentValues';
import { hasRole } from '../../../utils/roles';
import { isPresent } from '../../../utils/misc';
import {
  makeMessageSchema,
  EMPTY_FORM_VALUES,
  normalizeCallsign,
  type MessageFormData,
} from './create-message-drawer.schema';
import { useMessageUppy } from './useMessageUppy';
import { useMessageParser } from './useMessageParser';
import { useMessageSubmit } from './useMessageSubmit';

export type UseCreateMessageDrawerProps = {
  open: boolean;
  currentUser: User | null;
  onClose: () => void;
  onSuccess?: () => void;
  editTarget?: { id: number; message: InboxMessage } | null;
  editSaveInFlight?: boolean;
  onSubmitEdit?: (id: number, message: InboxMessage) => void | Promise<void>;
};

export function useCreateMessageDrawer({
  open,
  currentUser,
  onClose,
  onSuccess,
  editTarget = null,
  editSaveInFlight,
  onSubmitEdit,
}: UseCreateMessageDrawerProps) {
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

  const [computerNameOptions, setComputerNameOptions] = useState<string[]>([]);
  const [computerNamesLoading, setComputerNamesLoading] = useState(false);
  const [computerNameInput, setComputerNameInput] = useState('');

  const [postOptions, setPostOptions] = useState<string[]>([]);
  const [postLoading, setPostLoading] = useState(false);
  const [postInput, setPostInput] = useState('');

  const [unitOptions, setUnitOptions] = useState<string[]>([]);
  const [unitLoading, setUnitLoading] = useState(false);
  const [unitInput, setUnitInput] = useState('');

  const [networkNameOptions, setNetworkNameOptions] = useState<string[]>([]);
  const [networkNameLoading, setNetworkNameLoading] = useState(false);
  const [networkNameInput, setNetworkNameInput] = useState('');

  const [signalNameOptions, setSignalNameOptions] = useState<string[]>([]);
  const [signalNameLoading, setSignalNameLoading] = useState(false);
  const [signalNameInput, setSignalNameInput] = useState('');

  const [callsignOptions, setCallsignOptions] = useState<string[]>([]);
  const [callsignLoading, setCallsignLoading] = useState(false);
  const [callsignInput, setCallsignInput] = useState('');

  const [freqOptions, setFreqOptions] = useState<string[]>([]);
  const [freqLoading, setFreqLoading] = useState(false);
  const [freqInput, setFreqInput] = useState('');

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

  useEffect(() => {
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
  }, [postInput]);

  useEffect(() => {
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
  }, [unitInput]);

  useEffect(() => {
    let active = true;

    setNetworkNameLoading(true);
    searchNetworkNames(networkNameInput)
      .then((results) => {
        if (active) {
          setNetworkNameOptions(results.map((n) => n.name));
        }
      })
      .catch(console.error)
      .finally(() => {
        if (active) setNetworkNameLoading(false);
      });

    return () => {
      active = false;
    };
  }, [networkNameInput]);

  useEffect(() => {
    let active = true;

    setSignalNameLoading(true);
    searchSignalNames(signalNameInput)
      .then((results) => {
        if (active) {
          setSignalNameOptions(results.map((s) => s.name));
        }
      })
      .catch(console.error)
      .finally(() => {
        if (active) setSignalNameLoading(false);
      });

    return () => {
      active = false;
    };
  }, [signalNameInput]);

  useEffect(() => {
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
  }, [callsignInput]);

  useEffect(() => {
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
  }, [freqInput]);

  const { uppy, uppyFiles, fileInputRef, handleFileSelect, handleDrop, handleDropzoneKeyDown } =
    useMessageUppy(busy, setErrorMsg);

  const resolver = useMemo(() => zodResolver(makeMessageSchema(isEditMode)), [isEditMode]);

  const methods = useForm<MessageFormData>({
    resolver,
    mode: 'onTouched',
    reValidateMode: 'onChange',
    defaultValues: EMPTY_FORM_VALUES,
  });

  const { getValues, setValue, reset } = methods;

  const { parsing, handleParse } = useMessageParser(methods, busy, setErrorMsg);

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
    setComputerNameInput('');
    setShowAdvanced(false);
    setErrorMsg(null);
    if (isEditMode && editTarget) {
      reset({
        ...mapInboxMessageToForm(editTarget.message, tagsMap),
        text: editTarget.message.text ?? '',
        signalGroupMasterKey: editTarget.message.groupMasterKey ?? '',
        computerName: '',
        network_signal_name: '',
        network_cc: '',
        network_name: '',
        dmr_sender_id: '',
        dmr_sender_name: '',
        dmr_call_group_id: '',
        dmr_call_group_name: '',
        dmr_hash_id: '',
      });
    } else {
      reset({
        ...EMPTY_FORM_VALUES,
        date: dayjs(),
        time: dayjs(),
      });
    }
  }, [open, isEditMode, editTarget?.id]);

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
    tagsMap,
    setSubmitting,
    setErrorMsg,
    uppy,
    addValues,
    onSuccess,
    handleDrawerClose,
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
    computerNameOptions,
    computerNamesLoading,
    computerNameInput,
    setComputerNameInput,
    postOptions,
    postLoading,
    setPostInput,
    unitOptions,
    unitLoading,
    setUnitInput,
    networkNameOptions,
    networkNameLoading,
    setNetworkNameInput,
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
    handleDropzoneKeyDown,
    methods,
    handleParse,
    handleDrawerClose,
    getProposedCallsigns,
    addSuggestedCallsign,
    onSubmit,
    recentValues,
  };
}
