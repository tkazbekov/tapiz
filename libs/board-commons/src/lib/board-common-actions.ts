const ActionType = '[Board]';

export const BoardCommonActions = {
  setBoardName: `${ActionType} SetBoardName`,
  broadcast: `${ActionType} Broadcast`,
  moveUser: `${ActionType} MoveUser`,
  setState: `${ActionType} Set state`,
  // the whole board again, after hiding or revealing notes
  resyncState: `${ActionType} Resync state`,
  stateAction: `${ActionType} State action`,
  batchNodeActions: `${ActionType} Batch node actions`,
  deleteMember: `${ActionType} Delete member`,
  changeRole: `${ActionType} Change role`,
};
