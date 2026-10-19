# AGENTS.md

## Steps for a Session

1. Evaluate the task's scope before beginning. If it is too large to handle effectively within a single session or available context, tell the user what the limitation is and identify a coherent subset that can be completed. Do not arbitrarily stop when useful progress can still be made.
2. Before making implementation changes, present a brief, explicit plan to the user. The plan should identify the intended changes, relevant files or components, and any meaningful risks or uncertainties. Keep it proportional to the task: 1–3 sentences for small changes, more detail only when warranted. Stop after presenting the plan and wait for explicit user approval before implementing, even when the user directly requests implementation. Only skip this approval checkpoint if the user explicitly instructs you to proceed without planning or approval.
3. Use subagents only when context isolation or genuinely independent work justifies the cost, such as broad external research, many-file investigation, or independent review of changes affecting architecture, async lifecycle, authentication, or several interacting files.
4. Do not delegate tiny edits, a handful of file reads, mechanical changes, simple debugging, or documentation work merely for the sake of delegation.
5. Prefer changes that remain reasonably reviewable within a single session. Do not broaden an implementation into large refactors, cleanup, or unrelated improvements merely because they become apparent while working. If the required change grows substantially beyond the original scope, finish at a coherent boundary where practical and clearly identify the remaining work.

## Working Session Guidelines + Constraints

- `README.md` describes the project's established goals, user-facing scope, important constraints, and non-goals. Do not redefine or expand product scope in the README based on implementation choices.
- Treat `README.md` as read-only by default. Do not update it as part of routine implementation, refactoring, bug fixes, or session wrap-up.
- Modify `README.md` only when:
  - The user explicitly requests a README update; or
  - A completed change makes an existing README statement materially incorrect, or introduces essential user-facing setup, usage, or configuration information without which the README would be misleading or insufficient.
- Do not update `README.md` merely to document implementation details, architectural decisions, development progress, or information already discoverable from the code.
- When neither exception applies, leave `README.md` unchanged. Do not perform speculative documentation maintenance.
- Add information to the `Extra Vital Context` section of this file only when an implementation decision creates durable context that:
  - an unfamiliar agent would not readily discover from the code or existing documentation;
  - is important to how future sessions should understand or modify the project; and
  - would otherwise be easy to miss, misrepresent, or require substantial investigation to rediscover.
- Documentation updates should record established implementation realities, not redefine product requirements, speculate about future direction, or act as a running history of development.
- Keep `Extra Vital Context` concise. Do not use it as a changelog, implementation diary, or store of temporary state.
- Use GitHub issue comments (see `Task Tracking`) for continuity across sessions: progress, unfinished work, blockers, and next steps for that task. Only use `STATUS.md` for temporary context that belongs to no issue; keep it under 200 words and delete it when no longer useful.
- Other than `AGENTS.md`, `README.md`, and `STATUS.md` do not create or modify agent-oriented scaffolding or documentation unless directly required by the user's task. For example, do not introduce ADRs, context files, planning documents, or similar artifacts merely for process completeness.
- Do not add speculative extensibility, abstraction, configuration, providers, or architecture for hypothetical future requirements.

## Task Tracking

Work is tracked as GitHub issues in `jimgeng/obsidian-inline-suggestions`, on the `Inline Suggestions` project board (#3, https://github.com/users/jimgeng/projects/3) (Status: Todo → Ready → In Progress → In Review → Done). Use the `gh` CLI.

- Find work: `gh project item-list 3 --owner jimgeng --format json --jq '.items[] | select(.status=="Ready") | "#\(.content.number) \(.title)"'`. Only pick an issue whose `blockedBy` issues are closed (`gh issue view N --json blockedBy`).
- Per task: `gh issue view N --comments` → present the plan and wait for approval (Session step 2) → branch `issue-N-short-name` → implement and test → open a PR whose body contains `Closes #N` → set the board Status to In Review.
- Stay inside the issue's Scope/Out of scope. Record discovered follow-up work as new issues (`.github/ISSUE_TEMPLATE/task.md` headings, with `--add-blocked-by` where relevant) rather than expanding the current one.
- Before ending a session on unfinished work, leave a short hand-off comment on the issue.
- Move a card: get the item id with `gh project item-list 3 --owner jimgeng --format json --jq '.items[] | select(.content.number==N) | .id'`, then `gh project item-edit --id <item-id> --project-id PVT_kwHOAoS0i84BnJCL --field-id PVTSSF_lAHOAoS0i84BnJCLzhlvAr0 --single-select-option-id <option>`. Options: Todo `56880333`, Ready `3c66ac42`, In Progress `dc5c88e0`, In Review `c3bf103a`, Done `40725e76`. New issues need `gh project item-add 3 --owner jimgeng --url <issue-url>`.

## Extra Vital Context

- Copilot access goes through GitHub's official `@github/copilot-language-server` (installed globally with npm, run with the user's Node over stdio), which owns sign-in and tokens. The plugin is desktop-only. Do not implement direct HTTP calls to Copilot endpoints or custom OAuth.