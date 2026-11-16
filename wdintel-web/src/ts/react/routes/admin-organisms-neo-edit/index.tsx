import { Box, Tab, Tabs } from '@mui/material';
import { OrganismPeopleSection } from './OrganismPeopleSection';

import { FormPageHeader } from '../../components/FormPageHeader';
import { PageErrorState } from '../../components/PageErrorState';
import { PageLoadingState } from '../../components/PageLoadingState';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { OrganismFormFields, OrganismGoiSection } from './OrganismFormFields';
import { OrganismTagsSection } from './OrganismTagsSection';
import { useOrganismEditor } from './use-organism-editor';
import { AdminOrganismsNeoEditPageProps } from './use-organism-editor.shared';
function AdminOrganismsNeoEditPageBody(props: AdminOrganismsNeoEditPageProps) {
  const {
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
  } = useOrganismEditor(props);
  if (isNew && !globalAdmin) {
    return (
      <PageErrorState
        message="Створювати організми може лише Admin."
        actionLabel="Назад"
        onAction={navigateBack}
      />
    );
  }

  if (loadStatus === 'loading') {
    return <PageLoadingState />;
  }

  if (loadStatus === 'error') {
    return (
      <PageErrorState
        message={loadError || 'Помилка завантаження'}
        actionLabel="Назад"
        onAction={navigateBack}
      />
    );
  }

  return (
    <div className="w-full min-w-0">
      <div className="w-full min-w-0 space-y-echo-lg">
        <FormPageHeader
          title={isNew ? 'Створити організм' : 'Редагувати організм'}
          subtitle={
            isNew
              ? 'Додайте новий організм'
              : props.organismId
                ? `ID: ${props.organismId}`
                : undefined
          }
          onBack={navigateBack}
        />

        {status ? (
          <PowerAlert severity={status.kind} onClose={() => setStatus(null)}>
            {status.message}
          </PowerAlert>
        ) : null}

        <Tabs
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          value={activeTab}
          onChange={handleTabChange}
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          <Tab
            value="main"
            label="Основне"
            id="admin-organism-tab-main"
            aria-controls="admin-organism-panel-main"
          />
          <Tab
            value="users"
            label="Користувачі"
            id="admin-organism-tab-users"
            aria-controls="admin-organism-panel-people"
          />
          <Tab
            value="labels"
            label="Лейбли користувачів"
            id="admin-organism-tab-labels"
            aria-controls="admin-organism-panel-people"
          />
          <Tab
            value="tags"
            label="Теги"
            id="admin-organism-tab-tags"
            aria-controls="admin-organism-panel-tags"
          />
          {globalAdmin ? (
            <Tab
              value="goi"
              label="ГОІ"
              id="admin-organism-tab-goi"
              aria-controls="admin-organism-panel-goi"
            />
          ) : null}
        </Tabs>

        {activeTab === 'main' ? (
          <Box
            id="admin-organism-panel-main"
            role="tabpanel"
            aria-labelledby="admin-organism-tab-main"
            className="space-y-echo-lg"
          >
            <OrganismFormFields
              organismId={props.organismId === null ? null : Number(props.organismId)}
              form={form}
              formErrors={formErrors}
              isSubmitting={isSubmitting}
              isCheckingGoiConnection={isCheckingGoiConnection}
              isSettingUpGoiWorker={isSettingUpGoiWorker}
              isNew={isNew}
              organisms={organisms}
              logins={logins}
              groups={groups}
              availableGroups={availableGroups}
              aors={aors}
              computedGroups={computedGroups}
              computeError={computeError}
              goiConnectionStatus={goiConnectionStatus}
              isComputing={isComputing}
              groupsValidation={groupsValidation}
              onCheckGoiConnection={handleCheckGoiConnection}
              onSetupGoiWorker={handleSetupGoiWorker}
              onChange={handleChange}
            />

            <div className="flex justify-end gap-3">
              <PowerButton
                variant="outlined"
                onClick={navigateBack}
                disabled={isSubmitting || isCheckingGoiConnection || isSettingUpGoiWorker}
              >
                Скасувати
              </PowerButton>
              <PowerButton
                variant="contained"
                onClick={handleSubmit}
                disabled={isSubmitting || isCheckingGoiConnection || isSettingUpGoiWorker}
              >
                {isNew ? 'Створити' : 'Зберегти'}
              </PowerButton>
            </div>
          </Box>
        ) : null}

        {activeTab === 'users' || activeTab === 'labels' ? (
          <div
            id="admin-organism-panel-people"
            role="tabpanel"
            aria-labelledby={`admin-organism-tab-${activeTab}`}
          >
            <OrganismPeopleSection
              organismId={isNew ? null : Number(props.organismId)}
              mode={activeTab}
            />
          </div>
        ) : null}

        {activeTab === 'tags' ? (
          <Box
            id="admin-organism-panel-tags"
            role="tabpanel"
            aria-labelledby="admin-organism-tab-tags"
            sx={{ mt: -1 }}
          >
            <OrganismTagsSection organismId={isNew ? null : Number(props.organismId)} />
          </Box>
        ) : null}

        {globalAdmin && activeTab === 'goi' ? (
          <Box
            id="admin-organism-panel-goi"
            role="tabpanel"
            aria-labelledby="admin-organism-tab-goi"
          >
            <OrganismGoiSection
              disabled={isSubmitting || isCheckingGoiConnection || isSettingUpGoiWorker}
            />
          </Box>
        ) : null}
      </div>
    </div>
  );
}
export function AdminOrganismsNeoEditPage(props: AdminOrganismsNeoEditPageProps) {
  return <AdminOrganismsNeoEditPageBody organismId={props.organismId} />;
}
