# Accessibility verification

Release 1 targets WCAG 2.2 AA. Automated browser journeys run Axe on the board, drawers/dialogs, mobile layout, collaboration, notifications, search, backlog, administration, workflow/data settings, reports, and team access. Serious and critical findings fail the suite. Chromium, Firefox, and WebKit run in CI; touch behavior is exercised in Chromium.

The current M5 keyboard, 320 CSS-pixel reflow, text-spacing, target-size, reduced-motion, forced-colors, and cross-browser results are recorded in [`accessibility-evidence-2026-10-12.md`](./accessibility-evidence-2026-10-12.md). TJ The Test Director completed the human VoiceOver/Safari and visual-state sign-off below on 2026-10-12.

## Manual release checklist

- Complete sign-in, project selection, issue creation/edit, card movement, comment, attachment, search, notification, reports, and administration using only Tab, Shift+Tab, Enter, Space, Escape, and arrow keys.
- Confirm focus is always visible, follows dialogs when opened, returns to the trigger when closed, and never becomes trapped.
- At 200% browser zoom and a 320 CSS-pixel viewport, confirm content reflows without loss of controls or two-dimensional page scrolling (data tables may scroll in their own region).
- With VoiceOver/Safari or NVDA/Firefox, confirm page landmarks/headings, form labels and errors, dialog names, board column/card names, movement announcements, status messages, and table headers.
- Confirm color is not the only carrier of priority, state, warnings, or errors; verify contrast in normal, hover, focus, and disabled states.
- Confirm pointer targets remain at least 24 by 24 CSS pixels or have sufficient spacing, and every drag action has a non-drag alternative.
- Test prefers-reduced-motion, forced colors/high contrast, and browser text spacing overrides.

Record the browser, assistive technology/version, viewport/zoom, tester, date, failures, and linked fixes in the release evidence. Automated Axe coverage cannot replace this manual screen-reader and keyboard pass.

## Human assistive-technology sign-off record

Use this table against the release image, not the development server. Replace every `PENDING` value and link any defect before approving the release.

| Field                        | Result                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Tester                       | TJ The Test Director                                                                                                    |
| Date and time zone           | 2026-10-12, America/Chicago                                                                                             |
| Release image digest         | `sha256:76d0dafb313bc6be8afccfd7e4bc8826e05a2e1e9dd6d9fc63d5d958054e0bb9` (local candidate; promotion approval pending) |
| Operating system/version     | macOS 26.6.2 (build 25G83)                                                                                              |
| Browser/version              | Safari 26.6.2                                                                                                           |
| Assistive technology/version | VoiceOver 10                                                                                                            |
| Viewport and zoom            | Current Safari window at 100% and 200% zoom; automated evidence separately covers 320 CSS pixels.                       |

Sign in as the demo administrator for administrative scenarios and as a member for everyday issue work. Test with speech enabled and avoid using the pointer unless a scenario explicitly calls for the visual contrast review.

| Scenario                            | Expected result                                                                                                                                 | Result | Defect/fix evidence                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------- |
| Sign in and project selection       | Landmarks and headings describe the page; controls have useful names; invalid credentials announce an associated error.                         | `PASS` | Human VoiceOver/Safari check completed 2026-10-12.              |
| Create and edit an issue            | Labels, required state, validation errors, Markdown help, and dialog name are announced; focus enters the dialog and returns to its trigger.    | `PASS` | Human VoiceOver/Safari check completed 2026-10-12.              |
| Read the board                      | Board region, columns, issue keys, summaries, status, priority, and available card actions are understandable without visual position or color. | `PASS` | Human VoiceOver/Safari check completed 2026-10-12.              |
| Move a card without dragging        | The destination/action is named, the move is operable from the keyboard, and success or failure is announced through a live status.             | `PASS` | Human VoiceOver/Safari check completed 2026-10-12.              |
| Open and close the issue drawer     | The drawer name is announced, focus remains inside while open, Escape closes it, and focus returns to the originating card.                     | `PASS` | Human VoiceOver/Safari check completed 2026-10-12.              |
| Comment, mention, watch, and attach | Each control and upload state is announced; success, validation, malware-scan, and removal states are understandable.                           | `PASS` | Human VoiceOver/Safari check completed 2026-10-12.              |
| Search and saved filters            | Query/filter controls, selected values, result count, result headings, paging, and empty state are announced in a useful order.                 | `PASS` | Human VoiceOver/Safari check completed 2026-10-12.              |
| Notifications                       | Unread state, preference controls, mark-read actions, and issue destinations are distinguishable and operable.                                  | `PASS` | Human VoiceOver/Safari check completed 2026-10-12.              |
| Reports and administration tables   | Table captions/regions, headers, filters, paging, empty states, and row actions preserve context.                                               | `PASS` | Human VoiceOver/Safari check completed 2026-10-12.              |
| Visual state review                 | Text and meaningful UI meet contrast expectations in normal, hover, focus, disabled, warning, and error states; color is never the only cue.    | `PASS` | Human Safari review at 100% and 200% zoom completed 2026-10-12. |

### Approval

- Overall result: `PASS` — all scenarios passed and the release owner accepted the accessibility evidence; release-image promotion remains pending.
- Accepted exceptions and owner: None reported.
- Tester signature/date: TJ The Test Director — 2026-10-12
- Release owner signature/date: TJ The Test Director — 2026-10-12

Every accessibility scenario is recorded as passing and the tester signature closes `PRD-01`. M5 remains subject to the separate release-owner signature, immutable release-image promotion, and deployment checklist.
