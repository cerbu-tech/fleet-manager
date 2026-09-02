# Threat model

The honest boundaries, stated up front:

## What actually contains an agent

- **Mechanical guarantees only**: branch protection on target repos, deploy keys
  without push to protected branches, push/PR allowlists per subject. These hold
  even when the agent is wrong or manipulated.
- **Not a barrier**: tool restrictions in headless CLI sessions. `Bash` is built in;
  an agent that can run shell commands on a node sees what that node's user sees.
  Config-level tool filtering is context hygiene, not security.

## Layers, in order of trust (M1)

1. **Policy engine** (`config.yaml`) — first line, not a guarantee. Explicit auto
   verdicts only: worker spawns within the daily budget, artifact publishes to
   allowlisted repos on unprotected branches. Everything else — closure,
   clarification, protected-branch targets, repos outside the allowlist, any new
   action type — stays a pending decision for a human. Every escalation is a row in
   `decisions`; policy approvals are marked `resolved_by = 'policy'`.
2. **Mechanical anchoring** (GitHub/remote side) — the guarantee that holds when the
   agent is wrong: branch protection on `main` of every target repo (direct pushes
   rejected server-side), and — on restricted setups — deploy keys that cannot push
   protected branches. The policy engine failing does NOT expose `main`: the remote
   rejects the push regardless of what the manager or a worker tries.

   **Trap, verified empirically**: a GitHub branch protection rule with no
   "require a pull request" setting only blocks force-pushes and deletions — a plain
   `git push origin main` still lands. The setting that actually rejects direct
   pushes (`GH006 … Changes must be made through a pull request`) is
   `required_pull_request_reviews`; `required_approving_review_count: 0` keeps the
   merge itself as the human's approval without demanding a second account. Enable
   `enforce_admins`: the agents run under the operator's own account.

   ```bash
   gh api -X PUT repos/OWNER/REPO/branches/main/protection --input - <<'EOF'
   {"required_status_checks":null,"enforce_admins":true,
    "required_pull_request_reviews":{"required_approving_review_count":0},
    "restrictions":null,"allow_force_pushes":false,"allow_deletions":false}
   EOF
   ```

   Verify it the same way every time: push a throwaway commit straight to `main` and
   expect `[remote rejected] … (protected branch hook declined)`.

The negative e2e test (`src/test/publish.test.ts`) exercises layer 1: a scripted
publish targeting `main` stays a pending decisions row and nothing is pushed. Layer 2
must be configured per target repo (documented in the README of the target hub);
verify it by pushing to `main` directly — the remote must reject it.

## Trust model (v1)

- Workers run on **trusted nodes** — machines where the operator's credentials
  (git, MCP servers, tokens) are already present. The worker inherits that access.
- Restricted nodes (agent auth + deploy key only, no data-source credentials) are a
  documented roadmap item, not part of v1.

## Known risks (tracked in the plan)

| Risk | Mitigation |
|---|---|
| Prompt injection from data sources (M2 connectors) | Source content is data, not instructions; proposals-only (never auto-start); push/PR allowlist; mechanical anchors above |
| OAuth expiry | First failed spawn is classified `auth_failure` and alerted (M2); boot health-check covers complete absence |
| Manager restart with sessions in flight | Boot reconciliation: a session is re-adopted when its tmux session is alive or its output file is fresh (claude >= 2.1.252 leaves its tmux pane at boot); otherwise drained once and marked failed. A re-adopted worker that silently died is escalated to the operator within `stall_minutes` |
| API exposure | Static bearer token from environment; bind only to an explicitly configured address |
