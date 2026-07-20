export type ManageMessageSubmitEligibilityInput = {
  busy: boolean;
  parsing: boolean;
  schemaValid: boolean;
  isEditMode: boolean;
  groupsLoading: boolean;
  selectedGroupKey: string;
  accessibleGroupKeys: readonly string[];
  text: string;
  fullBody: string;
  newAttachmentCount: number;
  existingAttachmentIds: readonly string[];
  deletedAttachmentIds: readonly string[];
  maxAttachmentCount: number;
};

export function isManageMessageSubmitEligible({
  busy,
  parsing,
  schemaValid,
  isEditMode,
  groupsLoading,
  selectedGroupKey,
  accessibleGroupKeys,
  text,
  fullBody,
  newAttachmentCount,
  existingAttachmentIds,
  deletedAttachmentIds,
  maxAttachmentCount,
}: ManageMessageSubmitEligibilityInput): boolean {
  const deletedIds = new Set(deletedAttachmentIds);
  const retainedAttachmentCount = existingAttachmentIds.filter((id) => !deletedIds.has(id)).length;
  const attachmentCount = retainedAttachmentCount + newAttachmentCount;
  const hasContent = Boolean(text.trim() || fullBody.trim() || attachmentCount > 0);
  const hasAccessibleGroup =
    isEditMode || (!groupsLoading && accessibleGroupKeys.some((key) => key === selectedGroupKey));

  return (
    !busy &&
    !parsing &&
    schemaValid &&
    hasAccessibleGroup &&
    hasContent &&
    attachmentCount <= maxAttachmentCount
  );
}
