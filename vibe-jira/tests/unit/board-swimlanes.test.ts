import type { BoardView, IssueView } from "@vibe/contracts";
import { boardSwimlanes } from "../../apps/web/lib/board-swimlanes";
import { describe, expect, it } from "vitest";

function issue(
  id: string,
  key: string,
  issueType: IssueView["issueType"],
  options: Partial<IssueView> = {},
): IssueView {
  return {
    id,
    key,
    summary: key,
    description: "",
    priority: "MEDIUM",
    issueType,
    statusId: "status",
    rank: "1024.0000000000",
    version: 1,
    reporter: { id: "reporter", displayName: "Reporter" },
    assignee: null,
    labels: [],
    estimatePoints: null,
    dueDate: null,
    parent: null,
    epic: null,
    updatedAt: "2026-10-12T00:00:00.000Z",
    allowedTransitions: [],
    ...options,
  };
}

const epic = issue("epic", "LANE-1", "EPIC", {
  epic: { id: "epic", key: "LANE-1", summary: "LANE-1" },
});
const story = issue("story", "LANE-2", "STORY", {
  assignee: { id: "alice", displayName: "Alice" },
  parent: {
    id: epic.id,
    key: epic.key,
    summary: epic.summary,
    issueType: "EPIC",
  },
  epic: { id: epic.id, key: epic.key, summary: epic.summary },
});
const subtask = issue("subtask", "LANE-3", "SUBTASK", {
  parent: {
    id: story.id,
    key: story.key,
    summary: story.summary,
    issueType: "STORY",
  },
  epic: { id: epic.id, key: epic.key, summary: epic.summary },
});
const unparented = issue("task", "LANE-4", "TASK");
const board: BoardView = {
  id: "board",
  name: "Board",
  project: { id: "project", key: "LANE", name: "Lanes" },
  columns: [],
  statuses: [],
  assignees: [
    { id: "alice", displayName: "Alice" },
    { id: "bob", displayName: "Bob" },
  ],
  epics: [{ id: epic.id, key: epic.key, summary: epic.summary }],
  issues: [epic, story, subtask, unparented],
  issueNeighbors: {},
  columnPages: [],
};

describe("board swimlanes", () => {
  it("keeps all active assignees plus a stable unassigned lane", () => {
    const lanes = boardSwimlanes(board, board.issues, "assignee");
    expect(lanes.map((lane) => lane.name)).toEqual([
      "Alice",
      "Bob",
      "Unassigned",
    ]);
    expect(lanes[0]?.issues.map((item) => item.id)).toEqual([story.id]);
    expect(lanes[1]?.issues).toEqual([]);
    expect(lanes[2]?.issues.map((item) => item.id)).toEqual([
      epic.id,
      subtask.id,
      unparented.id,
    ]);
  });

  it("resolves nested descendants to their epic and preserves empty lanes while filtered", () => {
    const lanes = boardSwimlanes(board, [subtask], "epic");
    expect(lanes.map((lane) => lane.name)).toEqual([
      "LANE-1 · LANE-1",
      "No epic",
    ]);
    expect(lanes[0]?.issues.map((item) => item.id)).toEqual([subtask.id]);
    expect(lanes[1]?.issues).toEqual([]);
  });
});
