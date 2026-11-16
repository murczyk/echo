import type { SyntheticEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useOrganismManagement } from '../admin-organisms-neo/management-context';

import {
  AreaOfResponsibility,
  Login,
  CreateOrganismReq,
  Organism,
  OrganismGroup,
  SignalGroupFull,
  UpdateOrganismReq,
} from '../../../../Bindings';
import { listLogins } from '../../services/api/logins';
import { listAors } from '../../services/api/aor';
import {
  addGroupToOrganism,
  computeAvailableGroups,
  computeAvailableGroupsForNew,
  createOrganism,
  GOI_INTEGRATION_TYPE_FULL,
  GOI_INTEGRATION_TYPE_SIMPLE,
  listOrganismGroups,
  listOrganisms,
  listSignalGroups,
  removeGroupFromOrganism,
  updateOrganism,
} from '../../services/api/organisms';
import { navigateWithinSpa } from '../../utils/browser';
import {
  AdminOrganismsNeoEditPageProps,
  buildAvailableGroups,
  emptyFormState,
  formatErrorMessage,
  getBackToPath,
  getOrganismGroupKeys,
  getSimpleGoiUrl,
  LoadingStatus,
  OrganismEditTab,
  OrganismFormState,
  StatusMessage,
  validateGroupsForParent,
} from './use-organism-editor.shared';
import { useOrganismGoiActions } from './use-organism-goi-actions';
export function useOrganismEditor(props: AdminOrganismsNeoEditPageProps) {
  const { globalAdmin } = useOrganismManagement();
  const isNew = !props.organismId;
  const [activeTab, setActiveTab] = useState<OrganismEditTab>('main');
  const [loadStatus, setLoadStatus] = useState<LoadingStatus>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [logins, setLogins] = useState<Login[]>([]);
  const [organisms, setOrganisms] = useState<Organism[]>([]);
  const [groups, setGroups] = useState<SignalGroupFull[]>([]);
  const [organismGroups, setOrganismGroups] = useState<OrganismGroup[]>([]);
  const [aors, setAors] = useState<AreaOfResponsibility[]>([]);

  const [form, setForm] = useState<OrganismFormState>(emptyFormState);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [originalGroupKeys, setOriginalGroupKeys] = useState<string[]>([]);
  const [computedGroups, setComputedGroups] = useState<SignalGroupFull[] | null>(null);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [isComputing, setIsComputing] = useState(false);

  const {
    goiConnectionStatus,
    setGoiConnectionStatus,
    isCheckingGoiConnection,
    isSettingUpGoiWorker,
    handleCheckGoiConnection,
    handleSetupGoiWorker,
  } = useOrganismGoiActions(props, form, setForm);
  const backToPath = useMemo(getBackToPath, []);

  const availableGroups = useMemo(
    () => buildAvailableGroups(form.parentId, groups, organismGroups),
    [form.parentId, groups, organismGroups],
  );

  const groupsValidation = useMemo(
    () => validateGroupsForParent(organismGroups, groups, form.groupIds, form.parentId),
    [organismGroups, groups, form.groupIds, form.parentId],
  );

  useEffect(() => {
    let isCancelled = false;

    async function loadAll() {
      setLoadStatus('loading');
      setLoadError(null);
      try {
        const [organismsData, groupsData, organismGroupsData, aorData, loginsData] =
          await Promise.all([
            listOrganisms({ sortBy: null }),
            globalAdmin ? listSignalGroups() : Promise.resolve([]),
            globalAdmin ? listOrganismGroups() : Promise.resolve([]),
            globalAdmin ? listAors({ sortBy: null }) : Promise.resolve([]),
            listLogins({ sortBy: null, filterByRoles: null }),
          ]);
        if (isCancelled) return;

        setOrganisms(organismsData);
        setLogins(loginsData.users);
        setGroups(groupsData);
        setOrganismGroups(organismGroupsData);
        setAors(aorData);

        if (isNew) {
          setForm(emptyFormState);
          setOriginalGroupKeys([]);
          setGoiConnectionStatus(null);
          setLoadStatus('success');
          return;
        }

        const parsedId = Number(props.organismId);
        if (!Number.isFinite(parsedId)) {
          setLoadStatus('error');
          setLoadError('Некоректний id');
          return;
        }

        const target = organismsData.find((item) => item.id === parsedId);
        if (!target) {
          setLoadStatus('error');
          setLoadError('Організм не знайдено');
          return;
        }

        const groupKeys = getOrganismGroupKeys(target.id, organismGroupsData);
        if (isCancelled) return;

        setOriginalGroupKeys(groupKeys);
        setForm({
          name: target.name,
          parentId: target.parentId,
          roles: target.roles,
          adminLogins: target.adminLogins,
          aorIds: target.aorIds,
          enabled: target.enabled,
          limitGroups: groupKeys.length > 0,
          groupIds: groupKeys,
          goiIntegrationType: emptyFormState.goiIntegrationType,
          goiSshHost: emptyFormState.goiSshHost,
          goiSshUser: emptyFormState.goiSshUser,
          goiSshPort: emptyFormState.goiSshPort,
          goiPath: emptyFormState.goiPath,
          goiApiHost: emptyFormState.goiApiHost,
          goiApiPort: emptyFormState.goiApiPort,
          goiApiLogin: emptyFormState.goiApiLogin,
          goiApiPassword: emptyFormState.goiApiPassword,
          goiSimpleUrl: emptyFormState.goiSimpleUrl,
          goiSimpleUrlDirty: emptyFormState.goiSimpleUrlDirty,
        });
        setGoiConnectionStatus(null);
        setLoadStatus('success');
      } catch (error) {
        if (isCancelled) return;
        setLoadStatus('error');
        setLoadError(formatErrorMessage(error));
      }
    }

    loadAll();

    return () => {
      isCancelled = true;
    };
  }, [props.organismId, isNew, globalAdmin]);

  useEffect(() => {
    if (!globalAdmin || loadStatus !== 'success') return;
    if (form.aorIds.length === 0) {
      setComputedGroups(null);
      setComputeError(null);
      setIsComputing(false);
      return;
    }

    let isCancelled = false;

    async function loadComputed() {
      setIsComputing(true);
      setComputeError(null);
      try {
        if (isNew) {
          const req: CreateOrganismReq = {
            name: form.name,
            parentId: form.parentId,
            roles: form.roles,
            adminLogins: null,
            aorIds: form.aorIds,
          };
          const data = await computeAvailableGroupsForNew(req);
          if (!isCancelled) setComputedGroups(data);
        } else {
          const parsedId = Number(props.organismId);
          if (!Number.isFinite(parsedId)) {
            if (!isCancelled) {
              setComputeError('Некоректний id');
              setComputedGroups(null);
            }
            return;
          }
          const req: UpdateOrganismReq = {
            id: parsedId,
            parentId: form.parentId,
            name: form.name,
            roles: form.roles.length > 0 ? form.roles : null,
            adminLogins: null,
            enabled: form.enabled,
            aorIds: form.aorIds,
          };
          const data = await computeAvailableGroups(req);
          if (!isCancelled) setComputedGroups(data);
        }
      } catch (error) {
        if (!isCancelled) {
          setComputedGroups(null);
          setComputeError(formatErrorMessage(error));
        }
      } finally {
        if (!isCancelled) setIsComputing(false);
      }
    }

    loadComputed();

    return () => {
      isCancelled = true;
    };
  }, [form.aorIds, form.parentId, isNew, loadStatus, props.organismId, globalAdmin]);

  function handleChange(patch: Partial<OrganismFormState>) {
    if (
      patch.goiSshHost !== undefined ||
      patch.goiIntegrationType !== undefined ||
      patch.goiSshUser !== undefined ||
      patch.goiSshPort !== undefined ||
      patch.goiPath !== undefined ||
      patch.goiApiHost !== undefined ||
      patch.goiApiPort !== undefined ||
      patch.goiApiLogin !== undefined ||
      patch.goiApiPassword !== undefined ||
      patch.goiSimpleUrl !== undefined
    ) {
      setGoiConnectionStatus(null);
    }
    setForm((prev) => {
      const next = { ...prev, ...patch };
      if (
        (patch.goiIntegrationType === undefined ||
          patch.goiIntegrationType === GOI_INTEGRATION_TYPE_FULL) &&
        patch.goiSshHost !== undefined &&
        prev.goiApiHost.trim().length === 0 &&
        (patch.goiApiHost === undefined || patch.goiApiHost.trim().length === 0)
      ) {
        next.goiApiHost = patch.goiSshHost;
      }
      if (
        patch.goiIntegrationType === GOI_INTEGRATION_TYPE_SIMPLE &&
        prev.goiIntegrationType !== GOI_INTEGRATION_TYPE_SIMPLE
      ) {
        if (!prev.goiSimpleUrlDirty) {
          next.goiSimpleUrl = getSimpleGoiUrl(
            patch.goiApiHost ?? prev.goiApiHost,
            patch.goiSshHost ?? prev.goiSshHost,
          );
        }
      }
      if (patch.goiSimpleUrl !== undefined) {
        next.goiSimpleUrlDirty = true;
      }
      return next;
    });
  }

  function navigateBack() {
    navigateWithinSpa(backToPath);
  }

  function handleTabChange(_: SyntheticEvent, value: OrganismEditTab) {
    setActiveTab(value);
  }

  function validateForm(): boolean {
    const errors: Record<string, string> = {};
    if (!form.name.trim()) {
      errors.name = 'Заповніть назву';
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit() {
    if (!validateForm()) return;

    setIsSubmitting(true);
    setStatus(null);

    try {
      const trimmedName = form.name.trim();
      const nextForm = { ...form, name: trimmedName };
      const selectedGroupIds = nextForm.limitGroups ? nextForm.groupIds : [];

      if (isNew) {
        const createReq: CreateOrganismReq = {
          name: nextForm.name,
          parentId: nextForm.parentId,
          roles: nextForm.roles,
          adminLogins: nextForm.adminLogins,
          aorIds: nextForm.aorIds.length > 0 ? nextForm.aorIds : null,
        };
        const created = await createOrganism(createReq);

        if (selectedGroupIds.length > 0) {
          await Promise.all(
            selectedGroupIds.map((groupId) =>
              addGroupToOrganism({
                organismId: created.id,
                groupName: groupId,
              }),
            ),
          );
        }
      } else {
        const parsedId = Number(props.organismId);
        if (!Number.isFinite(parsedId)) {
          throw new Error('Некоректний id');
        }

        const updateReq: UpdateOrganismReq = {
          id: parsedId,
          parentId: nextForm.parentId,
          name: nextForm.name,
          roles: nextForm.roles.length > 0 ? nextForm.roles : null,
          adminLogins: nextForm.adminLogins,
          enabled: nextForm.enabled,
          aorIds: nextForm.aorIds,
        };
        await updateOrganism(updateReq);

        if (globalAdmin) {
          const selectedGroupSet = new Set(selectedGroupIds);
          const originalGroupSet = new Set(originalGroupKeys);
          const toAdd = selectedGroupIds.filter((key) => !originalGroupSet.has(key));
          const toRemove = originalGroupKeys.filter((key) => !selectedGroupSet.has(key));

          if (toAdd.length > 0) {
            await Promise.all(
              toAdd.map((groupId) =>
                addGroupToOrganism({ organismId: parsedId, groupName: groupId }),
              ),
            );
          }
          if (toRemove.length > 0) {
            await Promise.all(
              toRemove.map((groupId) =>
                removeGroupFromOrganism({ organismId: parsedId, groupName: groupId }),
              ),
            );
          }
        }
      }

      navigateBack();
    } catch (error) {
      setStatus({
        kind: 'error',
        message: isNew
          ? `Помилка створення організму: ${formatErrorMessage(error)}`
          : `Помилка збереження організму: ${formatErrorMessage(error)}`,
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return {
    globalAdmin,
    isNew,
    activeTab,
    loadStatus,
    loadError,
    status,
    setStatus,
    isSubmitting,
    form,
    formErrors,
    organisms,
    logins,
    groups,
    availableGroups,
    aors,
    computedGroups,
    computeError,
    goiConnectionStatus,
    isComputing,
    groupsValidation,
    isCheckingGoiConnection,
    isSettingUpGoiWorker,
    navigateBack,
    handleTabChange,
    handleChange,
    handleCheckGoiConnection,
    handleSetupGoiWorker,
    handleSubmit,
  };
}
