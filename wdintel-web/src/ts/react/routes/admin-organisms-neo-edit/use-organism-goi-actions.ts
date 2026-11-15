import type { Dispatch, SetStateAction } from 'react';
import { useState } from 'react';

import {
  checkOrganismGoiConnection,
  GOI_INTEGRATION_TYPE_FULL,
  GOI_INTEGRATION_TYPE_SIMPLE,
  setupOrganismGoiWorker,
  type UpdateOrganismGoiSettingsReq,
} from '../../services/api/organisms';
import {
  AdminOrganismsNeoEditPageProps,
  formatErrorMessage,
  getSimpleGoiUrl,
  GOI_API_PORT_DEFAULT,
  GOI_PATH_DEFAULT,
  GOI_SSH_PORT_DEFAULT,
  hasAnyGoiApiSettings,
  OrganismFormState,
  StatusMessage,
} from './use-organism-editor.shared';
export function useOrganismGoiActions(
  props: AdminOrganismsNeoEditPageProps,
  form: OrganismFormState,
  setForm: Dispatch<SetStateAction<OrganismFormState>>,
) {
  const isNew = !props.organismId;
  const [goiConnectionStatus, setGoiConnectionStatus] = useState<StatusMessage>(null);
  const [isCheckingGoiConnection, setIsCheckingGoiConnection] = useState(false);
  const [isSettingUpGoiWorker, setIsSettingUpGoiWorker] = useState(false);
  function buildGoiSettingsReq(
    organismId: number,
    nextForm: OrganismFormState,
  ): UpdateOrganismGoiSettingsReq {
    const hasGoiApiSettings = hasAnyGoiApiSettings(nextForm);
    if (nextForm.goiIntegrationType === GOI_INTEGRATION_TYPE_SIMPLE) {
      const simpleGoiUrl = nextForm.goiSimpleUrl.trim();
      return {
        organismId,
        integrationType: GOI_INTEGRATION_TYPE_SIMPLE,
        sshHost: '',
        sshUser: '',
        sshPort: GOI_SSH_PORT_DEFAULT,
        path: GOI_PATH_DEFAULT,
        apiHost: simpleGoiUrl,
        apiPort: GOI_API_PORT_DEFAULT,
        apiLogin: '',
        apiPassword: '',
      };
    }
    return {
      organismId,
      integrationType: GOI_INTEGRATION_TYPE_FULL,
      sshHost: nextForm.goiSshHost.trim(),
      sshUser: nextForm.goiSshUser.trim(),
      sshPort: nextForm.goiSshPort,
      path: nextForm.goiPath.trim() || GOI_PATH_DEFAULT,
      apiHost: hasGoiApiSettings ? nextForm.goiApiHost.trim() || nextForm.goiSshHost.trim() : '',
      apiPort: nextForm.goiApiPort,
      apiLogin: hasGoiApiSettings ? nextForm.goiApiLogin.trim() : '',
      apiPassword: hasGoiApiSettings ? nextForm.goiApiPassword.trim() : '',
    };
  }

  async function handleCheckGoiConnection() {
    setIsCheckingGoiConnection(true);
    setGoiConnectionStatus(null);
    try {
      const response = await checkOrganismGoiConnection({
        sshHost: form.goiSshHost.trim(),
        sshUser: form.goiSshUser.trim(),
        sshPort: form.goiSshPort,
        path: form.goiPath.trim() || GOI_PATH_DEFAULT,
      });
      if (!response.ok || response.error) {
        setGoiConnectionStatus({
          kind: 'error',
          message: response.error
            ? `Помилка перевірки з'єднання: ${response.error}`
            : "Помилка перевірки з'єднання: Невідома помилка",
        });
        return;
      }
      const preview = response.listedEntries.slice(0, 5).join(', ');
      setGoiConnectionStatus({
        kind: 'success',
        message: preview
          ? `З'єднання успішне. Файли в каталозі: ${preview}`
          : "З'єднання успішне. Каталог доступний.",
      });
    } catch (error) {
      setGoiConnectionStatus({
        kind: 'error',
        message: `Помилка перевірки з'єднання: ${formatErrorMessage(error)}`,
      });
    } finally {
      setIsCheckingGoiConnection(false);
    }
  }

  async function handleSetupGoiWorker() {
    if (isNew) return;

    const parsedId = Number(props.organismId);
    if (!Number.isFinite(parsedId)) {
      setGoiConnectionStatus({
        kind: 'error',
        message: 'Помилка налаштування воркера: Некоректний id',
      });
      return;
    }

    setIsSettingUpGoiWorker(true);
    setGoiConnectionStatus(null);

    try {
      const settings = await setupOrganismGoiWorker({
        organismId: parsedId,
        sshHost: form.goiSshHost.trim(),
        sshUser: form.goiSshUser.trim(),
        sshPort: form.goiSshPort,
        path: form.goiPath.trim() || GOI_PATH_DEFAULT,
        apiHost: form.goiApiHost.trim() || form.goiSshHost.trim(),
        apiPort: form.goiApiPort,
      });
      setForm((prev) => ({
        ...prev,
        goiIntegrationType: settings.integrationType,
        goiSshHost: settings.sshHost,
        goiSshUser: settings.sshUser,
        goiSshPort: settings.sshPort,
        goiPath: settings.path,
        goiApiHost: settings.apiHost,
        goiApiPort: settings.apiPort,
        goiApiLogin: settings.apiLogin,
        goiApiPassword: settings.apiPassword,
        goiSimpleUrl: getSimpleGoiUrl(settings.apiHost, settings.sshHost),
        goiSimpleUrlDirty: settings.integrationType === GOI_INTEGRATION_TYPE_SIMPLE,
      }));
      setGoiConnectionStatus({
        kind: 'success',
        message:
          "Воркер налаштовано. API логін 'goi' і згенерований пароль записані в /etc/goi-echo-worker/config.toml та підставлені у форму.",
      });
    } catch (error) {
      setGoiConnectionStatus({
        kind: 'error',
        message: `Помилка налаштування воркера: ${formatErrorMessage(error)}`,
      });
    } finally {
      setIsSettingUpGoiWorker(false);
    }
  }

  return {
    goiConnectionStatus,
    setGoiConnectionStatus,
    isCheckingGoiConnection,
    isSettingUpGoiWorker,
    handleCheckGoiConnection,
    handleSetupGoiWorker,
  };
}
