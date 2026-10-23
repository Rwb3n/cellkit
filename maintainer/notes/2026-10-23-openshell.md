# NVIDIA OpenShell, and callsheet's run in it (2026-10-23)

The operator asked whether NVIDIA's agent sandbox is useful to cellkit: as technology, and for its patterns. Two read-only investigations (OpenShell's docs and repo; callsheet's trial), with the serious claims checked against GitHub. "OpenSandbox" is Alibaba's, a different project.

## What it is

- **OpenShell** (github.com/NVIDIA/OpenShell), Apache-2.0, v0.1.0 on 2026-09-25, **v0.1.5 on 2026-10-20** (checked), weekly releases, experimental interfaces may change in a patch.
- A gateway (control plane), one supervisor per sandbox (policy, credentials, DNS, approved connections) and the sandbox itself: one non-root identity, no capabilities, Landlock for files, seccomp user-notify for TCP and DNS. The workload has no network of its own; everything goes through the supervisor. Fail closed: the agent starts only once the boundary is confirmed, and freezes if the supervisor disconnects.
- Policy: YAML, deny by default. Files, Landlock and process are fixed at start; network rules and middleware hot-reload, with revisions and rollback. Network rules name host:port **and the binaries** allowed (pinned by SHA256 at first use). HTTP-level rules are opt-in and default to audit-only; non-HTTP egress (git, ssh) is relayed uninspected.
- Every blocked connection drafts a policy proposal; a human approves or rejects with a reason (`openshell rule approve/reject`); the agent can't approve its own. Agent-authored proposals are off by default.
- Credentials are "providers": the sandbox sees placeholders, the supervisor substitutes the real secret only on a request the policy allows and the credential is bound to.
- Logs: OCSF events (network, HTTP, process, config changes), text or JSONL; JSON export is "best-effort". No file-access event class found.
- Files are copied in and out (`--upload`, `sandbox download`); bind mounts exist but bypass the file policy.

Sources: docs.nvidia.com/openshell (overview, architecture, policies, advisor, providers, logging, support matrix), the NVIDIA blog post of 2026-09-28, the GitHub API.

## Why not now, here

- Windows is WSL 2 + Docker Desktop, **Experimental** (support matrix, checked).
- Open #3880: sandboxes never become Ready on WSL 2 + Docker Desktop (checked open).
- Open #3728: upload from a `/mnt/<drive>` path writes all-NUL files (checked open). Every project here is on `D:`.
- Open #3331: no subscription (OAuth) login; an API key, billed apart (checked open).
- A worktree's `.git` names an absolute `D:/…` gitdir: git inside needs a bind mount (which loses the file policy) or a clone.

## callsheet's trial (callsheet #67, branch `cellkit-trial`, 556a6cb)

- 2026-10-17, OpenShell v0.1.4 on WSL 2, one cell (`reader`). Policy: reads `/usr /lib /proc /etc`, writes `/sandbox /tmp`, Landlock `hard_requirement`, network only `api.anthropic.com:443` for `/usr/local/bin/claude`. Key as a provider (placeholder inside).
- `run-cell.sh`: stage the listed files without `.git`, upload, `claude -p --setting-sources user`, download, copy back only `process/` and `cells/reader/`.
- Worked: the task in 11 turns, $0.27, landed (34f5f01) after the full suite; egress blocked as written; a probe file wasn't copied back; `cell audit` clean.
- Broke: the kit's hooks off inside (they need git); the file list made on Windows (WSL git can't read the gitdir); mail carried by hand; WSL's own Docker needed (Docker Desktop's integration fails), one WSL VM shared with Supabase; docs ahead of v0.1.4; a `node_modules` link emptied by `git worktree remove`.
- The operator parked it the same day ("revisit if a second owner, cells on a Linux server with its own Docker, or real personal data to fence") and dismantled it on 2026-10-21. callsheet adopted cellkit v0.3.0 without the sandbox.

## For cellkit

On a Linux host it is a real boundary, which the hooks are not; it doesn't replace them (it knows no tool calls, no cells). That is #44's, when cells run elsewhere. Patterns worth taking now:

1. **Every refusal is an event.** The kit's hooks record nothing when they refuse: a refusal shows only in that session. Filed as its own issue.
2. **A refusal drafts a proposal** for the operator, never approved by the agent: the kit has the approval half (stage, amend, approve). Only once refusal logs show repeated friction.
3. **Fail closed when the checker is lost:** #38.
4. **What may change mid-run:** OpenShell fixes files at start; the kit reads `guards.json` live, so a cell mid-task picks up a new guard. A decision, not a bug.
5. **Copy in, audit, copy back:** callsheet's filter is `cell audit`'s idea; confirmed, nothing to build.
6. **Secrets as placeholders bound to endpoints:** needs a proxy; noted for #44.

Not for the kit: the gateway and fleet management, Kubernetes, layered admin policies. Those are a fleet layer's, if one is ever built on the cell contract (see the Roadmap issue).
