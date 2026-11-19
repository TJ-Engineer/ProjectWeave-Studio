import type { BoardChangeEvent, BoardView } from "@vibe/contracts";

export type BoardVersionMap = Map<string, number>;

function versionKey(entity: BoardChangeEvent["entity"], id: string): string {
  return `${entity}:${id}`;
}

export function boardVersions(board: BoardView): BoardVersionMap {
  const versions: BoardVersionMap = new Map();
  mergeBoardVersions(versions, board);
  return versions;
}

export function mergeBoardVersions(
  versions: BoardVersionMap,
  board: BoardView,
): void {
  for (const issue of board.issues) {
    versions.set(versionKey("issue", issue.id), issue.version);
  }
  for (const column of board.columns) {
    versions.set(versionKey("board_column", column.id), column.version);
  }
}

export function acceptBoardChange(
  projectId: string,
  versions: BoardVersionMap,
  event: BoardChangeEvent,
): boolean {
  if (event.projectId !== projectId) return false;
  const key = versionKey(event.entity, event.entityId);
  const current = versions.get(key) ?? 0;
  if (event.version <= current) return false;
  versions.set(key, event.version);
  return true;
}
