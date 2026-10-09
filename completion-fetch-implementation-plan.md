# Completion fetching implementation plan

## Decision

Split the work into **six implementation slices**, each with its own tests and reviewable completion boundary. Slices 1–2 establish safe automatic requests using the fake provider; slice 3 establishes whether authorized Copilot access is viable; slices 4–5 deliver real completions; slice 6 adds typed-through reuse without weakening correctness.

This is a plan only. No implementation is included. Proposed filenames and constants are recommendations, not existing APIs or settled service requirements.

Why six:

- Scheduling and host/editor integration have different failure modes and should be tested separately.
- Authentication must be independently verified before building on an undocumented completion endpoint.
- Streaming transport and Markdown insertion processing need separate fixtures and correctness checks.
- Typed-through reuse changes the existing conservative ghost-text invalidation policy, so it deserves its own slice rather than being mixed into initial networking.
- Advanced caching, similar-note retrieval, progressive rendering, and a generic provider framework are not necessary for this goal.

### What exists

| Component | Current behavior | Consequence for fetching |
| --- | --- | --- |
| `src/completion-provider.ts` | Plain prefix/suffix context; `complete(context): Promise<string \| null>` | Correct isolation boundary, but no cancellation input yet. |
| `src/fake-provider.ts` | Configurable deterministic text or null, immediately resolved | Keep for demos; use deferred/abort-aware test doubles for lifecycle tests. |
| `src/main.ts` | Demo command captures an immutable editor state, sends the entire prefix/suffix, then calls `showGhost`; errors are swallowed | No automatic triggers, debounce, request identity, timeout, authentication, or unload cancellation. |
| `src/ghost-text.ts` | Literal CM6 widget, full/word acceptance, dismissal, isolated undo, composition/focus guards | Reuse rendering and acceptance rather than rebuilding them. |
| `showGhost` | Requires exact source-state identity and focus, with composition/read-only/extension checks | Useful final safety gate, but not a substitute for request cancellation or lifecycle identity. |
| `ghostField` | Clears on any document edit or explicit selection transaction; partial acceptance restores a checked remainder | Typed-through reuse is not implemented. Preserve conservative behavior until slice 6. |
| `src/suggestion.ts` | Normalizes line endings, limits text to 10,000 characters, allows multiline only at line ends | Keep these layout/insertion constraints throughout fetching. Whitespace-only text currently remains valid. |
| Tests | Suggestion validation and jsdom ghost transaction/DOM tests | No scheduler, provider, auth, transport, or host-plugin lifecycle coverage yet. |
| Build/manifest | Browser-target bundle, host CodeMirror externalized; `isDesktopOnly: false` | Do not assume Node networking or desktop-only APIs. Mobile support remains a runtime verification requirement. |

`Editor.cm` is feature-detected in `main.ts` but is not a public typed Obsidian bridge. Existing host verification remains open: Source mode, Live Preview, IME, wrapping/scrolling, split panes, keybindings, and plugin disable/re-enable.

## Intended end-to-end flow

1. Eligible user typing in a focused Markdown editor invalidates obsolete work and starts a debounce.
2. After the pause, capture the current source state and construct bounded prefix/suffix context.
3. A per-editor request identity and abort signal accompany the provider call.
4. The Copilot provider obtains a cached valid credential, makes a bounded streaming completion request, and accumulates one candidate.
5. Completed insertion text is conservatively normalized and checked against suffix overlap and current layout restrictions.
6. The controller confirms request identity, editor lifetime, eligibility, and source state, then calls `showGhost`.
7. Acceptance or dismissal cannot trigger a request loop. Matching ordinary typing can retain the remainder only after slice 6 is verified.

Editor lifecycle and rendering must not know GitHub endpoints, headers, tokens, OAuth mechanics, model identifiers, or SSE framing. GitHub-specific code must not import CodeMirror or Obsidian editor types. Host credential/network adapters may use Obsidian APIs, but stay outside the editor logic.

## Slice 1 — Cancellable request controller and bounded context

**Outcome:** A deterministic, host-independent request lifecycle, exercised with fake providers before automatic requests are enabled.

Likely files: extend `src/completion-provider.ts`; add `src/completion-controller.ts`, `src/completion-context.ts`, and corresponding unit tests. Leave the immediate demo fake simple unless the production contract requires a small signature update.

Work:

- Add an `AbortSignal` to the provider call contract. Keep the result as insertion text or null; do not introduce a provider registry or streaming UI API.
- Implement a small controller with a debounce timer, monotonic generation/request identity, one active request per editor owner, bounded request timeout, and explicit cancellation/disposal.
- Aborting is advisory: a provider that ignores abort or resolves late must still be unable to publish a result.
- Distinguish cancellation, no completion, and failure internally. Failures must not become unhandled rejections or editing interruptions.
- Add a pure bounded context helper. Start with a proposed 8,000-character prefix and 2,000-character suffix, clipped without splitting surrogate pairs. These are local safety defaults, not Copilot token budgets. Map to verified model limits in slice 4.
- Extract only the bounded range from the document; do not serialize a whole large note and then truncate it.
- Initially send only current-note Markdown text. Do not add note paths, headings as separate metadata, other notes, recent edits, or vault traversal.
- Suggested initial debounce: 300 ms. Suggested completion timeout: 15 seconds. Keep these as named implementation constants until evidence warrants settings; do not build a settings framework.

Tests/exit gate:

- Burst typing produces one call; superseding work cancels timers and aborts active calls.
- A slower older promise cannot beat a newer request, including when it ignores abort.
- Cancel/dispose during debounce, request, timeout, or rejection produces no result or leak.
- Boundary clipping, empty suffix/prefix, multiline context, Unicode, and large-note extraction are covered.
- Controller tests use a controllable clock/deferred promises rather than timing-sensitive sleeps.

## Slice 2 — Automatic CM6 triggers and complete editor lifecycle

**Outcome:** Pause-after-typing produces fake ghost text automatically and safely in Obsidian; still no real network dependency.

Likely files: add `src/completion-extension.ts`; update `src/main.ts`; narrowly adjust `src/ghost-text.ts` if lifecycle signals/annotations are needed; add integration tests.

Work:

- Use a CM6 `ViewPlugin` (or equivalently scoped extension) to own a controller per view and observe transactions. Register through the existing Obsidian editor-extension path rather than polling the active editor.
- Request only after qualifying ordinary text input in an eligible Markdown view. Do not request on initial open, arbitrary selection changes, ghost effects, `input.complete`, undo/redo, or programmatic edits. Start conservatively with typing and committed IME text; defer paste/deletion triggers unless explicitly justified.
- Require focus, one empty selection, writable state, no active composition, and a live Markdown editing context. Confirm how Obsidian scopes registered editor extensions; do not assume every CM6 host view is a note editor.
- Cancel on incompatible edits, explicit selection movement, blur, mouse interaction, composition start, note/view replacement, read-only transition, teardown, or plugin unload.
- Escape/dismiss must cancel pending requests even when no ghost exists. Blur followed by refocus and Escape before a promise resolves must not resurrect a suggestion.
- Capture the source state immediately before requesting. Preserve exact state identity checks initially: even harmless intervening transactions may conservatively discard a result.
- Check identity/lifetime again before publishing and retain `showGhost` as the final guard. Do not dispatch synchronously from a CM6 update callback; publish outside that update to avoid reentrant-update errors.
- Avoid requesting again while a partial-acceptance remainder is visible; acceptance annotations and ghost effects must not create a loop.
- Keep demo preview explicitly fake and separate from the future authenticated automatic provider. Any async demo request also needs cancellation/identity protection so it cannot override newer automatic work.
- Disposal must reach every registered view, not just the active pane. No result may dispatch after view destruction or plugin disable.

Tests/exit gate:

- jsdom tests cover qualifying typing, debounce, state changes, effects-only updates, acceptance, selection, blur/refocus, dismissal during requests, IME, read-only changes, and teardown.
- Two editors have independent state; a result for one cannot appear in the other.
- Manual scratch-vault checks: Source/Live Preview, split panes, note switching, plugin disable/re-enable, real IME, undo/redo, and normal Tab behavior.
- A fake completion can be requested, rendered, accepted, and undone without modifying normal editing behavior.

## Slice 3 — Copilot access feasibility and credential lifecycle

**Outcome:** A verified authorized path to a reusable Copilot token, independent of the keystroke lifecycle. This is a **hard gate for real transport**, not permission to guess internal API details.

Likely files: `src/copilot-auth.ts`, a narrowly scoped host credential adapter, auth tests, and minimal login/logout/status wiring in `src/main.ts` if needed.

First verify:

- Current service usage conditions and whether this third-party client can legitimately use an existing Copilot entitlement.
- An available GitHub OAuth application/flow, required scopes, token-exchange URL/schema, expiry semantics, entitlement errors, and supported completion-service configuration.
- Do not assume a VS Code GitHub session is available in Obsidian, reuse VS Code's OAuth client identity, extract another application's stored credentials, or treat a normal GitHub token as a completion bearer token.
- Determine supported secure credential storage and login/network behavior on desktop and mobile. Do not silently persist secrets in vault-synced plugin settings or use `.env` as end-user authentication.

Implementation, only after those checks:

- Prefer an explicit supported interactive login flow; choose device authorization only if the legitimate application/service supports it.
- Cache Copilot access tokens separately from GitHub login credentials and coalesce concurrent refreshes.
- Refresh shortly before verified expiry; the reference's five-minute margin is a starting observation, not a universal rule. Avoid an immediate refresh loop for short-lived tokens.
- Logout invalidates credentials and cancels pending completion work. Auth cancellation/unload prevents late token responses from restoring a signed-out session.
- A single editor cancellation must not incorrectly abort a shared token refresh needed by another editor; provider callers still honor their own signals before sending completions.
- Distinguish signed out, expired/invalid credentials, missing entitlement, denied login, and transient failures. Surface actionable status outside the typing loop; do not show a modal/notice for every keystroke.
- If safe persistence is unavailable, prefer session-only credentials pending a user decision rather than an insecure fallback.

Tests/exit gate:

- Mock login/exchange, expiry, concurrent refresh, failed refresh, logout during refresh, cancellation, and secret-safe error messages.
- Manually verify authorized login, entitlement failure, refresh, and logout without logging tokens or note text.
- If no authorized compatible service path is available, stop real-Copilot implementation here and record the blocker. Slices 1–2 remain useful; do not substitute an OpenAI subscription or unrelated provider without a new user decision.

## Slice 4 — Copilot completion transport and bounded SSE parsing

**Outcome:** A real provider returns one accumulated plain-text candidate from a verified completion endpoint, independently of editor rendering.

Likely files: `src/copilot-provider.ts`, `src/copilot-stream.ts`, narrowly scoped transport helper if necessary, and fixture-based tests. GitHub model/endpoint/header details remain inside this boundary.

Work:

- Reinspect the upstream serialization/parser sources listed in `how-vscode-does-it.md`; verify actual service responses and model availability. Do not freeze an endpoint or model based solely on the reference.
- Send the specialized prefix/suffix completion shape, Markdown/language metadata as required, verified generation parameters, intent headers, and Copilot bearer authorization. Do not use chat-completion messages.
- Prefer one candidate (`n: 1`) where supported. Accumulate by stable candidate index; never concatenate separate candidates.
- Select an abortable transport that genuinely supports streamed response bodies in Obsidian's runtime. Browser `fetch` may face CORS; do not assume Obsidian `requestUrl` streams or supports abort. Verify desktop/mobile behavior before choosing an adapter or changing platform support.
- Correctly decode UTF-8 across chunks and parse SSE across arbitrary byte boundaries, CRLF, event delimiters, comments, multi-line data, finish reasons, and terminal markers according to verified protocol.
- Bound total response bytes, individual event size, completion text, and time. Keep the provider's output cap aligned with the existing 10,000-character rendering limit. Abort/close the stream on cancellation, limits, or completion.
- Treat malformed, incomplete, or unexpectedly truncated streams as failures unless a verified protocol finish condition was reached. Do not publish arbitrary partial text after a network error.
- Return one complete string or null; progressive ghost rendering is deliberately deferred.
- Handle authentication failure with at most one authorized token-refresh/retry path. Treat rate limits/`Retry-After` as provider-wide cooldown; do not retry on every keystroke. No automatic retry loop for network/5xx errors.
- Never include raw tokens, request bodies, document content, or unsanitized server payloads in logs/notices. No telemetry.

Tests/exit gate:

- Mock request serialization, status handling, abort, timeout, and cooldown without live credentials.
- SSE fixtures cover split UTF-8 characters, split JSON/events, empty chunks, candidate indexes, valid termination, malformed JSON, abrupt EOF, and size limits.
- A cancellation-ignoring network adapter cannot cause publication because the controller still validates identity.
- A manual provider smoke test succeeds with a scratch note and verified credentials on the supported host runtime.

## Slice 5 — Insertion processing and real-provider integration

**Outcome:** Automatic authenticated suggestions are usable Markdown insertion text, fail unobtrusively, and do not duplicate known suffix text.

Likely files: add `src/completion-postprocess.ts` and tests; update `src/main.ts` and provider integration; retain `src/suggestion.ts` as the final general validator.

Work:

- Normalize line endings; preserve meaningful Markdown spaces, indentation, lists, and code fences. Do not apply blanket `trim()`, strip Markdown fences, or treat the result as a chat response.
- Remove only demonstrable insertion/suffix overlap: compare normalized candidate trailing text with the immediate suffix prefix. Use conservative rules and fixtures, particularly for whitespace and repeated Markdown delimiters; ambiguous overlap should reject or remain unchanged rather than delete unrelated content.
- Do not heuristically remove echoed prefix text without verified service behavior and a test case. Avoid inventing stop sequences that truncate legitimate Markdown.
- Reject empty, oversized, invalid, and suffix-only results. Preserve the existing whitespace-only policy unless deliberately changed with tests and rationale.
- Reject multiline candidates away from line ends; do not silently convert them to one line or introduce replacement ranges. Preserve insertion-only acceptance.
- Wire automatic requests to the real provider only when authorized. Logged-out/unavailable states send no note context; authentication is not initiated on each typing pause.
- Keep fake-provider tests and demo behavior explicit. Never silently display fake content after a real provider failure.
- Ensure errors and cooldown do not change editor focus, insert text, steal keybindings, or repeatedly notify the user. Minimal login/logout/status controls are enough; no elaborate settings UI.

Tests/exit gate:

- Fixtures cover lists, headings, fenced blocks, CRLF, indentation, meaningful trailing spaces, overlaps, no overlap, repeated delimiters, empty/null results, and mid-line multiline rejection.
- Full lifecycle tests use a mocked authenticated provider, including a late response after auth changes, pane changes, dismissal, and plugin teardown.
- `npm run typecheck`, `npm test`, and `npm run build` pass.
- Scratch-vault end-to-end check: login, pause typing, show, word/full accept, undo/redo, cancel by editing/moving/dismissing, service unavailable, logout, and reload.

**Slices 1–5 are the initial real-fetching milestone.** Do not hold this milestone hostage to optimizations, but do not claim broad host/platform compatibility without testing it.

## Slice 6 — Typed-through reuse without extra requests

**Outcome:** Ordinary matching typing consumes an existing suggestion locally, reducing flicker and unnecessary HTTP requests.

Likely files: targeted changes to `src/ghost-text.ts`, `src/completion-extension.ts`, and related tests. No completed-result cache or in-flight deduplication layer yet.

Work:

- Relax the current invalidation rule only for one ordinary user insertion exactly at the ghost anchor whose text is a prefix of the remaining suggestion, leaving a single empty cursor at the expected new position.
- Consume the inserted characters and move the remainder. A mismatch, unrelated edit, replacement, multiple changes/cursors, selection change, paste, undo/redo, or composition conservatively invalidates it.
- Do not infer typing from every document transaction: preserve the distinction between user typing, explicit acceptance, and programmatic changes.
- Suppress new requests while a valid remainder exists. When matching typing exhausts the ghost, initially wait for subsequent qualifying input rather than immediately chaining another request.
- Reuse displayed suggestions only. Do not rebase asynchronous results onto changed states; retain source-state and request-identity guarantees.
- Keep explicit word acceptance and its isolated undo semantics unchanged.

Tests/exit gate:

- Matching one/multiple characters retain the correct remainder without a provider call; mismatch invalidates and schedules only an eligible fresh request.
- Unicode, multiline/line-end restrictions, filtered transactions, full consumption, unrelated edits, IME, undo/redo, and selection movement remain safe.
- Existing ghost tests continue passing and host typing/acceptance remains natural in both editor modes.

## Order and scope boundaries

Recommended sequence: **1 → 2 → 3 → 4 → 5 → 6**.

Perform the feasibility questions from slice 3 early, before investing heavily in network work. Slices 1–2 can proceed against the fake provider even while that gate is unresolved. Slice 4 requires both the cancellation contract and verified authentication/runtime transport. Slice 5 requires actual transport fixtures. Slice 6 requires stable triggering and integration behavior.

Each slice should be completed and verified separately; do not combine all six into one large refactor. Before each implementation session, recheck current files, present the narrow plan, and obtain the project's required approval.

### Deferred intentionally

- Completed-result caches and in-flight request reuse beyond credential-refresh coalescing.
- Similar-note retrieval, heading enrichment, recent-edit context, vault indexing, or sending other open files.
- Progressive streaming ghost updates, multiple candidate cycling, replacement edits, or mid-line multiline rendering.
- VS Code dependency injection, prompt-rendering infrastructure, telemetry, experiments, or generic provider configuration.
- Adaptive debounce, broad tuning settings, persistent backend services, and automatic background authentication.

### Decisions still requiring evidence or user approval

1. Authorized OAuth application/flow and service compatibility with third-party use.
2. Safe credential persistence; session-only fallback versus any approved secure-storage mechanism.
3. Verified completion model, endpoint, headers, limits, generation parameters, and error schemas.
4. Abortable streaming transport on Obsidian desktop and mobile. The current mobile-capable manifest must not silently become inaccurate; any desktop-only change requires an explicit scope decision.
5. Any new user-facing settings or broader context collection beyond current-note prefix/suffix.

## Overall completion criteria

- A typing pause in an eligible Markdown editor yields an authenticated, bounded-context Copilot request and validated ghost insertion text.
- Obsolete work is cancelled where possible and always ignored; dismissal, focus changes, logout, view teardown, and plugin unload cannot resurrect results.
- No per-keystroke login/exchange, unbounded request storms, leaked credentials/note text, or unrelated context collection.
- Provider code remains replaceable without changing editor/rendering logic; no separate paid API subscription is introduced as the primary path.
- Existing rendering, acceptance, undo, and layout restrictions remain intact, with automated lifecycle/protocol tests and explicit host checks.
- README changes occur only if completed authentication/setup requires essential user instructions; no scope redefinition or routine documentation churn.
