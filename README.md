# Pi customizations

Portable [Pi](https://github.com/earendil-works/pi) extensions for context usage, ephemeral side chats, tool approvals, terminal notifications, and restricted background workers. Typechecked against `@earendil-works/pi-coding-agent` 0.87.1; background subprocess integration tested on 0.87.1 and 1.0.4. No Pi fork required.

## Install

```bash
pi install git:github.com/bluearpit/pi-customizations
pi list
```

In an existing Pi terminal, run `/reload`. Avoid keeping separate copies of these extensions under `~/.pi/agent/extensions/` or they will load twice. For testing without installing: `pi -e ./extensions/side.ts` or `pi -e ./extensions/context.ts`.

To upgrade an unpinned git installation, run `pi update --extensions` and `/reload`. For repeatable installs on several machines, pin the Git source to a release tag (for example `git:github.com/bluearpit/pi-customizations@v0.3.1`). Install Pi and configure model authentication separately on each machine.

## `/context`

Displays an estimated category breakdown of the active context in a collapsible TUI view, plus a compact footer meter. Token categories are *heuristic estimates*, not provider billing accounting. Compaction summaries are counted separately from other conversation messages.

## `/permissions` — tool approvals

The default mode reads Agent Recall's **`~/.agents/permissions.yaml`** at session start. Create it with `agentrecall permissions init --apply` if needed. The policy file is the single source of truth: listed `allow_shell` prefixes, workspace reads, `workspace_write` edits/writes, `external_write` roots, and supported `allow_fetch` hosts proceed without a prompt; unlisted model tool calls require approval. `deny_shell` is blocked. Complex shell expressions are never auto-approved by an `allow_shell` prefix.

- `/permissions default` — policy-backed approvals (startup default).
- `/permissions auto` — no prompts; explicit `deny_shell` commands and edits to the policy file remain blocked.
- `/permissions ask` — ask before **every** model tool call, including explicit denies; approvals are for one call only.
- `/permissions` — show the current mode. `/permissions reload` — reload the YAML after you edit it. Switching sessions resets the mode to Default.

When no approval UI exists, a call needing approval is **blocked**, not silently allowed. Missing or invalid policy blocks all model tool calls. Bare Pi SDK sessions that do not emit `session_start` load the policy on their first tool call; hosts should still call `session.bindExtensions({})` to initialize extension lifecycle events. A trusted noninteractive host can explicitly set `PI_CUSTOMIZATIONS_PERMISSIONS_MODE=auto` for its own process; the Telegram gateway does this while loading this package. The extension does **not** gate commands you type yourself with `!`, extension-internal actions, or subprocesses launched by an approved tool, and is not a sandbox. Shell denial detects visible command text, not every way a shell program can produce or execute it; use OS isolation for hard restrictions.

## Terminal notifications

Sends an OSC terminal notification after a Pi turn has fully settled, only in interactive mode. No notifications are written to headless SDK/Telegram logs.

## `/side [question]`

Opens a temporary, read-only pane on the right of the current terminal tab. It reads the main session's latest active branch and system prompt **before every side question**. Ask follow-up questions with **Enter**; use **Shift+Enter** for a new line and **Page Up/Down** (Fn + ↑/↓ on Mac) to scroll the side conversation. Press **Tab** to switch between the side pane and an empty main editor without closing the pane. If you have a draft in the main editor, Tab keeps its normal completion behavior; run **`/side`** or press **Ctrl+Alt+S** to refocus the pane instead. **Esc** while focused in the side pane discards it; reopening `/side` starts fresh. The pane overlays part of the main transcript rather than reflowing it, and side questions wait until an in-progress main turn finishes.

Side questions and replies are held only in memory; they are not appended to Pi's session, persisted as a second session, or sent to enabled tools. The side chat **cannot read new files, browse, or change your project**. Existing tool results in the main branch may still be in its inherited context. Provider requests still happen and can incur charges, even though those charges will not appear in Pi's saved session totals. Closing during a request aborts it best-effort; provider-side processing already started may still be billed. This is not a privacy boundary against the model provider.

The main conversation remains unchanged. Avoid using `/side` to ask questions that require fresh file access or tool execution.

## `/background`

Delegate a task to a separate Pi process while the parent stays available. Workers inherit a snapshot of the active, compaction-aware conversation, the effective system prompt, and the selected model/thinking level. Later parent turns are not forwarded. An unfinished tool batch at dispatch is omitted so the child never receives dangling tool calls.

```text
/background start /absolute/path/to/worktree -- Review identity matching
/background edit "/absolute/path/to/separate worktree" -- Implement the agreed changes
/background list
/background status <id>
/background logs <id>
/background result <id>
/background cancel <id>
```

Use `start` for **read-only review**. `edit` requires user confirmation and a **separate, clean, registered Git worktree in the parent's repository**. The extension does not create worktrees automatically. Each worker needs an explicit worktree root, not a subdirectory. IDs can be unambiguous prefixes. The model can use the `background` tool for the same operations, subject to the parent's `/permissions` policy, but cannot bypass edit confirmation. User-entered `/background` commands follow the explicit worker checks instead of the model-tool approval hook. RPC edit requests need a client that answers Pi's confirmation dialog.

The footer shows the running count; `status` shows the latest streamed text/tool activity. Completion appends an untrusted report preview and full report/log paths to the originating conversation without triggering another parent model turn. If you have moved to another branch, it only notifies; use `list`/`result` to inspect the old job. The parent must review the worktree diff before running checks, committing, or pushing. Worker costs are tracked separately, not added to parent session totals.

### Capability restrictions

Restrictions are implemented in the child's tool set and filesystem operations, not just its prompt:

- Review: `bg_read` and `bg_list`; edit additionally enables `bg_edit` and `bg_write`.
- Reads and writes stay within the selected worktree. Symlinks, hardlinks, special files, Git/Pi metadata, and known credential paths (including `.npmrc` and the entire `.kube` directory) are refused. This name-based filter is not a secret scanner and cannot protect secrets stored under other names. Edits require an exact unique match; writes use atomic replacement.
- **No shell, subprocess, browser, network/cloud, commit, push, PR, or ticket tools.** The selected model provider is the only supported network service. Workers cannot run tests or query prod, even read-only; they must report those as parent-reviewed follow-ups.
- Other extensions, skills, prompt templates, project context discovery, and project trust are disabled in the child. The inherited parent system prompt remains context, not authorization.
- The child receives a filtered environment: model authentication and basic process paths, not AWS profiles/keys, database URLs, GitHub tokens, or Node injection variables.

This is a **model-tool capability boundary, not an operating-system sandbox**. Pi itself, trusted provider/auth configuration, and this extension still run with your OS user's permissions. Protect against hostile local processes, concurrent filesystem replacement, compromised dependencies, or stronger network threats with a container/VM and narrowly scoped credentials. Context and source files can contain secrets and prompt injection; credential-name filtering is not exhaustive. The inherited history is sent to the model provider and stored in private local worker files.

Model authentication must be available through the child's ordinary Pi config or supported API-key environment variables. Session-only provider extensions/runtime credentials are not copied; a missing/different model or thinking setting fails rather than silently falling back.

### Lifecycle and recovery

Starts are supported in long-lived **interactive and RPC** sessions, not one-shot print/JSON runs. Up to four workers can run per parent session, with one edit worker per target worktree in that manager. Each worker has a 30-minute deadline, a 20 MiB event/stderr log cap, and a 256 KiB final-report cap. These are bounds on runtime/storage, not a token-spend budget.

`cancel` sends SIGTERM and escalates to SIGKILL after two seconds if the child has not exited. **Reloading, switching sessions, or quitting cancels and waits for running workers.** A dedicated liveness pipe aborts a child if its parent process disappears. This version does not detach workers from the parent or reattach them after a crash. Already-written edits remain for review; cancellation does not roll them back. Use a dedicated worktree per worker and do not have another Pi session or human write to it concurrently.

Records, the forked session, event stream, stderr, and result are stored under:

```text
~/.pi/agent/background/<project-sha256>/<parent-session-id>/<job-id>/
```

The project key hashes the canonical parent session working directory, independent of the worker's selected worktree. Records also validate that project identity, so identical session IDs in different projects cannot load or interrupt each other's jobs. Legacy unscoped job directories are not automatically imported; inspect their files manually if needed.

A custom `PI_CODING_AGENT_DIR` moves this directory too. Files are private and retained until you delete them. Returning to a session restores its job list; stale running records become `interrupted`, never automatically resumed. Unsupported/malformed records are rejected. Final reports have an integrity hash; altered/missing reports are not treated as valid completed output. Failures preserve partial reports and log paths. If final persistence itself fails, the original record remains recoverable as interrupted and the live parent receives a failure notice.

To test without installing: `pi -e ./extensions/background.ts`. Do not run `pi update` over an edited managed package checkout before saving your changes elsewhere.

## Development

```bash
npm ci
npm run check
npm test
```

The suite includes filesystem-policy tests, failure/recovery/cancellation cases, UI lifecycle tests, and localhost-only model fixtures that launch real Pi child/RPC processes. It does not call paid model APIs or production services. To test another installed Pi build:

```bash
PI_BACKGROUND_TEST_CLI=/path/to/pi-coding-agent/dist/cli.js \
  node --import tsx --test test/background-integration.test.ts test/background-parent-integration.test.ts
```

Extensions run with the user's Pi process permissions. Review third-party changes before installing or updating.
