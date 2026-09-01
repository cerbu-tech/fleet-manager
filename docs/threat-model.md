# Threat model — skeleton

To be filled in as milestones land. The honest boundaries, stated up front:

## What actually contains an agent

- **Mechanical guarantees only**: branch protection on target repos, deploy keys
  without push to protected branches, push/PR allowlists per subject (policy engine,
  M1). These hold even when the agent is wrong or manipulated.
- **Not a barrier**: tool restrictions in headless CLI sessions. `Bash` is built in;
  an agent that can run shell commands on a node sees what that node's user sees.
  Config-level tool filtering is context hygiene, not security.

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
