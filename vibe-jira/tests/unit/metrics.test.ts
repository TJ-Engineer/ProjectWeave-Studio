import { describe, expect, it } from "vitest";
import {
  categoryAt,
  computeIssueFlowMetrics,
  type MetricIssueTimeline,
} from "@vibe/domain";

const day = 86_400;

describe("published Kanban metric definitions", () => {
  it("derives lead, cycle, throughput boundary, and category time from events", () => {
    const timeline: MetricIssueTimeline = {
      issueId: "issue-1",
      issueKey: "MET-1",
      summary: "Known fixture",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      initialCategory: "TODO",
      currentCategory: "DONE",
      transitions: [
        {
          at: new Date("2026-01-02T00:00:00.000Z"),
          fromCategory: "TODO",
          toCategory: "IN_PROGRESS",
        },
        {
          at: new Date("2026-01-03T00:00:00.000Z"),
          fromCategory: "IN_PROGRESS",
          toCategory: "TODO",
        },
        {
          at: new Date("2026-01-04T00:00:00.000Z"),
          fromCategory: "TODO",
          toCategory: "IN_PROGRESS",
        },
        {
          at: new Date("2026-01-06T00:00:00.000Z"),
          fromCategory: "IN_PROGRESS",
          toCategory: "DONE",
        },
      ],
    };
    expect(
      computeIssueFlowMetrics(timeline, new Date("2026-01-07T00:00:00.000Z")),
    ).toEqual({
      leadTimeSeconds: 5 * day,
      cycleTimeSeconds: 4 * day,
      wipAgeSeconds: null,
      firstDoneAt: new Date("2026-01-06T00:00:00.000Z"),
      statusSeconds: {
        TODO: 2 * day,
        IN_PROGRESS: 3 * day,
        DONE: day,
      },
    });
    expect(categoryAt(timeline, new Date("2026-01-03T12:00:00.000Z"))).toBe(
      "TODO",
    );
    expect(categoryAt(timeline, new Date("2025-12-31T23:59:59.000Z"))).toBe(
      null,
    );
    expect(
      computeIssueFlowMetrics(timeline, new Date("2026-01-02T12:00:00.000Z"))
        .wipAgeSeconds,
    ).toBe(day / 2);
  });

  it("ages current work from its latest entry into in-progress", () => {
    const timeline: MetricIssueTimeline = {
      issueId: "issue-2",
      issueKey: "MET-2",
      summary: "Aging work",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      initialCategory: "TODO",
      currentCategory: "IN_PROGRESS",
      transitions: [
        {
          at: new Date("2026-01-02T00:00:00.000Z"),
          fromCategory: "TODO",
          toCategory: "IN_PROGRESS",
        },
        {
          at: new Date("2026-01-03T00:00:00.000Z"),
          fromCategory: "IN_PROGRESS",
          toCategory: "TODO",
        },
        {
          at: new Date("2026-01-05T00:00:00.000Z"),
          fromCategory: "TODO",
          toCategory: "IN_PROGRESS",
        },
      ],
    };
    const metrics = computeIssueFlowMetrics(
      timeline,
      new Date("2026-01-07T00:00:00.000Z"),
    );
    expect(metrics.wipAgeSeconds).toBe(2 * day);
    expect(metrics.leadTimeSeconds).toBeNull();
    expect(metrics.cycleTimeSeconds).toBeNull();
  });
});
