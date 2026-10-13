import type { BoardChangeEvent, BoardView } from "@vibe/contracts";
import {
  acceptBoardChange,
  boardVersions,
  mergeBoardVersions,
} from "../../apps/web/lib/board-realtime";
import { describe, expect, it } from "vitest";

const projectId = "10000000-0000-4000-8000-000000000001";
const issueId = "10000000-0000-4000-8000-000000000002";
const columnId = "10000000-0000-4000-8000-000000000003";

function board(): BoardView {
  return {
    id: "10000000-0000-4000-8000-000000000004",
    name: "Board",
    project: { id: projectId, key: "LIVE", name: "Live" },
    columns: [
      {
        id: columnId,
        name: "To Do",
        position: 0,
        wipLimit: null,
        version: 3,
        statusIds: [],
        issueCount: 1,
        tailIssueId: issueId,
        penultimateIssueId: null,
      },
    ],
    statuses: [],
    assignees: [],
    epics: [],
    issues: [
      {
        id: issueId,
        key: "LIVE-1",
        summary: "Live issue",
        description: "",
        priority: "MEDIUM",
        issueType: "TASK",
        statusId: "10000000-0000-4000-8000-000000000005",
        rank: "1024.0000000000",
        version: 4,
        reporter: { id: projectId, displayName: "Admin" },
        assignee: null,
        labels: [],
        estimatePoints: null,
        dueDate: null,
        parent: null,
        epic: null,
        updatedAt: "2026-10-12T00:00:00.000Z",
        allowedTransitions: [],
      },
    ],
    issueNeighbors: {
      [issueId]: { previousIssueId: null, nextIssueId: null },
    },
    columnPages: [{ columnId, total: 1, nextCursor: null }],
  };
}

function change(overrides: Partial<BoardChangeEvent> = {}): BoardChangeEvent {
  return {
    projectId,
    entity: "issue",
    entityId: issueId,
    version: 5,
    operation: "UPDATE",
    ...overrides,
  };
}

describe("board realtime version suppression", () => {
  it("accepts only a newer scoped entity version", () => {
    const versions = boardVersions(board());
    expect(acceptBoardChange(projectId, versions, change())).toBe(true);
    expect(acceptBoardChange(projectId, versions, change())).toBe(false);
    expect(acceptBoardChange(projectId, versions, change({ version: 4 }))).toBe(
      false,
    );
    expect(
      acceptBoardChange(
        projectId,
        versions,
        change({ projectId: "10000000-0000-4000-8000-000000000099" }),
      ),
    ).toBe(false);
  });

  it("tracks issue and column versions from a canonical refresh", () => {
    const canonical = board();
    const versions = new Map<string, number>();
    mergeBoardVersions(versions, canonical);
    expect(
      acceptBoardChange(
        projectId,
        versions,
        change({ entity: "board_column", entityId: columnId, version: 3 }),
      ),
    ).toBe(false);
    expect(
      acceptBoardChange(
        projectId,
        versions,
        change({ entity: "board_column", entityId: columnId, version: 4 }),
      ),
    ).toBe(true);
  });
});
