# Release candidate checklist

## Build and automated gates

- [ ] `npm ci`, `npm run check`, and `npm audit --audit-level=high` pass.
- [ ] Clean-schema and previous-boundary PostgreSQL migration jobs pass; no applied migration changed checksum.
- [ ] All PostgreSQL integration tests pass without skips.
- [ ] Chromium, Firefox, and WebKit browser suites pass, including permission and Axe gates.
- [ ] The load test passes on release-sized hardware and its p95 values are recorded.
- [ ] The production image passes high/critical vulnerability scanning and has immutable semantic-version, revision, and digest labels/tags.

## Deployment and operations

- [ ] Production secrets, HTTPS origin, trusted-proxy behavior, OIDC claims/redirect, object storage, malware scanner, and metrics protection are verified.
- [ ] Clean Compose startup reaches healthy state and the documented smoke journey passes.
- [ ] SIGTERM stops web and workers without forced kill or OOM; workers finish their active batch.
- [ ] Backup/recovery drill passes against release data, including counts, readiness, and retrieval of every active clean attachment.
- [ ] Upgrade from the previous release boundary and permitted rollback/forward-repair path are exercised.
- [ ] Dashboards/alerts cover readiness, database pool, outbox age/dead letters, jobs, error rate, latency, disk, and backup freshness.

## Product acceptance

- [ ] All twelve acceptance gates in `DEVELOPMENT_STORYBOARD.md` are `DONE` with evidence.
- [x] Keyboard, 320 CSS-pixel reflow, text-spacing, target-size, reduced-motion, forced-colors, and cross-browser Axe evidence is recorded in `accessibility-evidence-2026-10-12.md`.
- [x] Human VoiceOver/Safari and final visual contrast-state sign-off is recorded in the worksheet in `accessibility.md`.
- [ ] Admin and member onboarding, support escalation, data retention, and invitation delivery owners are named.
- [ ] The release owner approves `release-notes-0.1.0.md`, replaces its pending release-image/owner/window fields, and accepts its migrations, configuration changes, rollback posture, residual risks, and observation window.

The release owner signs and dates this checklist. A prepared but unexecuted checkbox is not release evidence.
