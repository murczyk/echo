export type AnalysisCallsignActions = {
  onAddCallsign: (callsign: string) => Promise<boolean> | boolean;
  onRemoveCallsign: (callsign: string) => Promise<boolean> | boolean;
};

export type MessageCardBotTagAction = {
  messageId: number;
  tagId: number;
};
