# Accessibility release evidence — 2026-10-12

Release target: Release 1 / M5  
Environment: local production Compose stack at `http://127.0.0.1:3000`  
Browser automation: Playwright 1.64.0, bundled Chromium, Firefox, and WebKit  
Reviewer: Codex automated and browser-assisted review

This record covers the repeatable keyboard, reflow, display-preference, target-size, and automated accessibility checks completed for M5. The complementary human VoiceOver/Safari and visual-state record is signed in [`accessibility.md`](./accessibility.md).

## Results

| Check                                | Result          | Evidence                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyboard sign-in and activation      | Pass            | Email receives the first Tab focus with a visible focus indicator; Enter submits sign-in and activates create, move, and close actions.                                                                                                                                                                 |
| Create dialog focus                  | Pass            | Opening the native dialog focuses Summary; Escape closes it and restores focus to `+ Create issue`.                                                                                                                                                                                                     |
| Issue drawer focus                   | Pass            | Opening focuses the named close button; repeated forward Tab stays inside; Escape closes and restores focus to the issue-card trigger in Chromium, Firefox, and WebKit.                                                                                                                                 |
| Non-drag movement                    | Pass            | A focused card movement button moves the issue and exposes a live status message; explicit movement remains available alongside pointer/touch drag.                                                                                                                                                     |
| 320 CSS-pixel reflow                 | Pass            | Projects, board, and create-dialog journeys have no document-level horizontal overflow. The Kanban columns and issue-window strip keep their necessary horizontal scrolling inside named, keyboard-focusable regions.                                                                                   |
| Text spacing                         | Pass            | WCAG text-spacing overrides retain controls and do not introduce document-level horizontal overflow at 320 CSS pixels.                                                                                                                                                                                  |
| Target size                          | Pass            | Every visible button, input, select, textarea, and link in the audited board journey is at least 24 by 24 CSS pixels in Chromium, Firefox, and WebKit.                                                                                                                                                  |
| Reduced motion                       | Pass            | With `prefers-reduced-motion: reduce`, computed animation and transition durations are at most 1 ms.                                                                                                                                                                                                    |
| Forced colors                        | Pass            | Chromium reports `forced-colors: active`; controls remain operable and the applicable Axe rules report no serious or critical findings. The normal color-contrast rule is intentionally excluded in this mode because forced-color system palette substitution makes its computed-color result invalid. |
| Default color contrast and semantics | Pass, automated | The full cross-browser suite runs Axe across the board, dialogs, search, backlog, administration, reports, and team access with no serious or critical findings. Priority, state, warnings, and errors also retain visible text, not color alone.                                                       |
| Browser-assisted visual check        | Pass            | The Projects view retained readable labels and complete controls during Chrome inspection. The deterministic 320 CSS-pixel test is the release zoom/reflow evidence.                                                                                                                                    |

## Regression result

Command:

```sh
PLAYWRIGHT_MATRIX=true npx playwright test
```

Result: 70 passed, 2 skipped. The two skips are the Chromium DevTools Protocol raw-touch case on Firefox and WebKit; all non-touch journeys, including the two focused accessibility cases, run in all three browsers.

Focused coverage lives in `tests/e2e/accessibility-release.spec.ts`. The corrected board-local scroll behavior is also covered by the Chromium raw-touch journey in `tests/e2e/first-slice.spec.ts`.

## Findings corrected during this pass

1. The issue drawer declared modal semantics without moving, containing, or restoring keyboard focus. It now focuses the close action, implements a cross-browser focus loop, closes on Escape, and restores the opener.
2. The mobile global header and project cards caused document-level horizontal overflow. The small-screen layout now wraps and contains long project text.
3. Kanban grids and issue-window controls expanded the document instead of owning their horizontal scrolling. They are now bounded, named, focusable scroll regions.
4. The drag handle and native WebKit selects could render below the 24 CSS-pixel target minimum. Explicit dimensions now preserve the minimum across engines.
5. The raw-touch regression helper now models edge scrolling inside the board-owned horizontal scroller.

## Human sign-off result

TJ The Test Director completed the VoiceOver 10/Safari 26.6.2 review on macOS 26.6.2 on 2026-10-12. All ten recorded scenarios passed, including landmarks and headings, labels and errors, dialog names and focus, board/card semantics, non-drag movement announcements, live statuses, collaboration, search, notifications, table context, and the final visual-state review. The signed scenario record and candidate-image identifier are in [`accessibility.md`](./accessibility.md).
