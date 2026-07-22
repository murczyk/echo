import React from 'react';
import { FormProvider, Controller } from 'react-hook-form';
import {
  Drawer,
  Typography,
  TextField,
  Button,
  IconButton,
  CircularProgress,
  Box,
  Stack,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';

import type { User, InboxMessage } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerForm } from '../../../components/PowerForm';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';

import { useManageMessageDrawer } from './useManageMessageDrawer';
import { FormSectionWrapper } from './drawer-sections/FormSectionWrapper';
import { AttachmentsSection } from './drawer-sections/AttachmentsSection';
import { SystemSection } from './drawer-sections/SystemSection';
import { MetadataSection } from './drawer-sections/MetadataSection';
import { NetworkSection } from './drawer-sections/NetworkSection';
import { DmrSection } from './drawer-sections/DmrSection';
import { LocationsSection } from './drawer-sections/LocationsSection';
import { CommentSection } from './drawer-sections/CommentSection';
import { AdvancedFieldsSection } from './drawer-sections/AdvancedFieldsSection';

export type Props = {
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

export function ManageMessageDrawer(props: Props) {
  const drawerState = useManageMessageDrawer(props);

  const {
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
    deviceNameOptions,
    deviceNamesLoading,
    setDeviceNameInput,
    uppy,
    uppyFiles,
    fileInputRef,
    handleFileSelect,
    handleDrop,
    handleDropzoneKeyDown,
    methods,
    canSubmit,
    handleParse,
    handleDrawerClose,
    getProposedCallsigns,
    addSuggestedCallsign,
    onSubmit,
    recentValues,
  } = drawerState;

  return (
    <Drawer
      anchor="right"
      open={props.open}
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

          <FormProvider {...methods}>
            <PowerForm
              id="create-message-form"
              noValidate
              onSubmit={methods.handleSubmit(onSubmit)}
              canSubmit={canSubmit}
              globalSubmitShortcut
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(0, 1fr)' },
                gap: 3,
                alignItems: 'start',
              }}
            >
              {/* LEFT COLUMN */}
              <Box component="fieldset" sx={{ minWidth: 0, border: 0, p: 0, m: 0 }}>
                <Typography component="legend" variant="subtitle2" sx={{ mb: 1 }}>
                  Вміст повідомлення <span aria-hidden="true">*</span>
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Додайте текст повідомлення або принаймні одне вкладення.
                </Typography>
                <Stack spacing={2.5}>
                  <FormSectionWrapper
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
                      control={methods.control}
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
                  </FormSectionWrapper>

                  <AttachmentsSection
                    uppy={uppy}
                    uppyFiles={uppyFiles}
                    fileInputRef={fileInputRef}
                    handleFileSelect={handleFileSelect}
                    handleDrop={handleDrop}
                    handleDropzoneKeyDown={handleDropzoneKeyDown}
                    busy={busy}
                    existingMedia={
                      isEditMode && props.editTarget ? props.editTarget.message.media : []
                    }
                    errorMsg={drawerState.attachmentErrorMsg}
                  />
                </Stack>
              </Box>

              {/* RIGHT COLUMN */}
              <Stack spacing={2.5}>
                <SystemSection
                  signalGroups={signalGroups}
                  groupsLoading={groupsLoading}
                  busy={busy}
                  isEditMode={isEditMode}
                  cyberEchoEnabled={props.cyberEchoEnabled}
                  deviceNameOptions={deviceNameOptions}
                  deviceNamesLoading={deviceNamesLoading}
                  setDeviceNameInput={setDeviceNameInput}
                  recentValues={recentValues}
                />

                <MetadataSection
                  isEditMode={isEditMode}
                  showAdvanced={showAdvanced}
                  busy={busy}
                  recentValues={recentValues}
                  tagOptions={tagOptions}
                  postOptions={drawerState.postOptions}
                  postLoading={drawerState.postLoading}
                  setPostInput={drawerState.setPostInput}
                  unitOptions={drawerState.unitOptions}
                  unitLoading={drawerState.unitLoading}
                  setUnitInput={drawerState.setUnitInput}
                  unitLocked={drawerState.unitLocked}
                  getProposedCallsigns={getProposedCallsigns}
                  addSuggestedCallsign={addSuggestedCallsign}
                  callsignOptions={drawerState.callsignOptions}
                  callsignLoading={drawerState.callsignLoading}
                  setCallsignInput={drawerState.setCallsignInput}
                />

                <NetworkSection
                  isEditMode={isEditMode}
                  busy={busy}
                  recentValues={recentValues}
                  networkNameOptions={drawerState.networkNameOptions}
                  networkNameLoading={drawerState.networkNameLoading}
                  setNetworkNameInput={drawerState.setNetworkNameInput}
                  freqOptions={drawerState.freqOptions}
                  freqLoading={drawerState.freqLoading}
                  setFreqInput={drawerState.setFreqInput}
                  unitLocked={drawerState.unitLocked}
                  setUnitLocked={drawerState.setUnitLocked}
                />

                <LocationsSection
                  busy={busy}
                  recentValues={recentValues}
                  open={props.open}
                  onError={setErrorMsg}
                />

                <CommentSection busy={busy} />

                <DmrSection showAdvanced={showAdvanced} busy={busy} recentValues={recentValues} />

                <AdvancedFieldsSection
                  showAdvanced={showAdvanced}
                  busy={busy}
                  recentValues={recentValues}
                  signalNameOptions={drawerState.signalNameOptions}
                  signalNameLoading={drawerState.signalNameLoading}
                  setSignalNameInput={drawerState.setSignalNameInput}
                />
              </Stack>
            </PowerForm>
          </FormProvider>
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
            <Button
              onClick={() => setShowAdvanced((prev) => !prev)}
              disabled={busy}
              color="inherit"
            >
              {showAdvanced ? 'Приховати розширені поля' : 'Розширені поля'}
            </Button>
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
              disabled={!canSubmit}
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
