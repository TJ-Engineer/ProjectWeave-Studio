import type { BoardView, IssueView, SwimlaneMode } from "@vibe/contracts";

export interface BoardSwimlane {
  id: string;
  name: string;
  issues: IssueView[];
}

export function boardSwimlanes(
  board: BoardView,
  visibleIssues: IssueView[],
  mode: SwimlaneMode,
): BoardSwimlane[] {
  if (mode === "none") {
    return [{ id: "none", name: "All work", issues: visibleIssues }];
  }

  if (mode === "assignee") {
    const assignees = new Map(
      board.assignees.map((assignee) => [assignee.id, assignee.displayName]),
    );
    for (const issue of board.issues) {
      if (issue.assignee) {
        assignees.set(issue.assignee.id, issue.assignee.displayName);
      }
    }
    const lanes = [...assignees]
      .sort((left, right) =>
        left[1].localeCompare(right[1], undefined, { sensitivity: "base" }),
      )
      .map(([id, name]) => ({
        id: `assignee:${id}`,
        name,
        issues: visibleIssues.filter((issue) => issue.assignee?.id === id),
      }));
    lanes.push({
      id: "assignee:unassigned",
      name: "Unassigned",
      issues: visibleIssues.filter((issue) => !issue.assignee),
    });
    return lanes;
  }

  const epics = board.epics;
  const lanes = epics.map((epic) => ({
    id: `epic:${epic.id}`,
    name: `${epic.key} · ${epic.summary}`,
    issues: visibleIssues.filter((issue) => issue.epic?.id === epic.id),
  }));
  lanes.push({
    id: "epic:none",
    name: "No epic",
    issues: visibleIssues.filter((issue) => issue.epic === null),
  });
  return lanes;
}
