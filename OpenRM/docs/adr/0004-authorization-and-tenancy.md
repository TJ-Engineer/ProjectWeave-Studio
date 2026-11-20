# ADR 0004: Authorization and tenancy

- Status: Accepted
- Date: 2026-11-07

## Decision

The organization is the hard tenant boundary. Every controlled row carries an organization identifier, and composite foreign keys prevent cross-tenant project references. OIDC authenticates the subject; the request selects an organization that must appear in the token's authorized organizations.

A centralized, deny-by-default policy engine evaluates roles and actions. Database access is repository-scoped so application queries cannot omit the organization predicate. A development token mode exists only outside production for deterministic local and CI checks.

## Consequences

Authorization behavior is testable apart from handlers and cross-tenant access fails before domain work begins. Production startup fails if development authentication is selected.

