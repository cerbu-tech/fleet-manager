# Privacy gateway — contract (not implemented)

fleet-manager is **work-only**. Consulting a personal assistant/agent (calendar,
personal notes, private context) is out of scope for v1. When it arrives (v2), it
goes through a privacy gateway with this contract:

1. **Eligibility on request** — every request from the manager to the personal agent
   is checked against an allowlist of purposes before it leaves the manager. Anything
   not explicitly work-relevant is rejected.
2. **Privacy on response** — the personal agent's response passes through a filter
   that strips personal context beyond the minimum needed to answer the request.
3. **Full audit** — every request/response pair is logged verbatim and reviewable by
   the operator.

Until this gateway exists, the manager has **no** channel to personal agents or
personal data sources. This document is the contract future work must satisfy; it is
intentionally implementation-free.
