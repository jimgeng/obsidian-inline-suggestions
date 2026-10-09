# VS Code Copilot Inline Completions: Reference

Research reference for implementing GitHub Copilot-powered inline Markdown suggestions in Obsidian. Based on the public `microsoft/vscode` Copilot implementation. This describes observed behavior, not a requirement to reproduce VS Code's architecture.

## 1. Completion lifecycle

Typical flow:

1. User types, causing the editor to request an inline completion.
2. Copilot checks eligibility, cancellation state, cursor position, and content restrictions.
3. It constructs a completion prompt using document context and optionally other sources.
4. A configurable debounce delays the request. Superseded requests are cancelled.
5. Existing suggestions, cached completions, and potentially in-flight requests may be reused instead of issuing a new request.
6. Otherwise, an authenticated request is sent to GitHub's Copilot completion service.
7. The streamed response is accumulated, trimmed, filtered, and checked against the current editor state.
8. The result is returned to the editor for ghost-text rendering and acceptance.

**Important:** Not every keystroke triggers an HTTP request. The system supports cancellation, caching, and continuing an existing suggestion as the user types matching characters.

## 2. Request format

Copilot uses a specialized text-completion endpoint rather than a conventional chat-completions interface.

Observed request fields:

- `prompt`: Text preceding the cursor.
- `suffix`: Text following the cursor.
- `extra.context`: Additional selected context, when present.
- `extra`: Language, indentation, and related metadata.
- `max_tokens`, `temperature`, `top_p`, `n`, `stop`: Generation parameters.
- `stream: true`: Stream the response.

The client constructs a model-specific proxy URL ending in `/v1/engines/{modelId}/completions` and identifies ghost-text requests using an `OpenAI-Intent` header.

Parameters, stop sequences, prompt budgets, and model selection are configurable or context-dependent. Do not assume universal fixed values.

## 3. Context selection

VS Code's prompt construction can include:

- Current document prefix and suffix.
- Document path and language marker.
- Contextual traits and diagnostics.
- Relevant code snippets from context providers.
- Similar-file snippets selected using token-based similarity.
- Recent edits.

Context is selected conditionally and constrained by token budgets. Copilot does not automatically send every open file or the entire workspace.

The implementation uses weighted prompt components to allocate available context. Similar-file selection uses techniques including Jaccard similarity.

**For Obsidian:** Begin with bounded Markdown prefix/suffix and optionally the current heading or section. Other notes, recent edits, and complex similarity matching are possible enhancements, not prerequisites.

## 4. Debounce, cancellation, and reuse

- Debounce duration can come from configuration or feature settings.
- Time spent preparing the request can count toward the debounce interval.
- Cancel requests that become obsolete.
- Check request identity before applying asynchronous results.
- Preserve an existing completion when the user types characters matching its suggestion.
- Cache and in-flight request reuse are additional optimizations.

Cancellation and stale-response protection are more important initially than advanced caching.

## 5. Response handling

The service returns a streaming text-completion response. Chunks contain candidate information such as `choices[].index`, `choices[].text`, and `choices[].finish_reason`.

The client accumulates text for each candidate. It can stop early using client-side completion rules, then post-processes generated text to handle formatting, whitespace, overlaps, and other constraints.

The final result is completion text, not a chat message or editor command. Rendering remains the editor integration's responsibility.

## 6. Authentication

VS Code's authentication flow:

1. Obtain a GitHub authentication session through VS Code.
2. Exchange its GitHub OAuth token for a Copilot-specific access token.
3. Cache that Copilot token and refresh it when approaching expiration (the examined implementation uses a five-minute margin).
4. Send authorized requests using the Copilot token.
5. Handle invalid credentials, unavailable entitlement, expiration, and rate limits.

Authentication is separate from the keystroke lifecycle; login/token exchange is not performed for every suggestion.

**Important:** GitHub's internal Copilot completion endpoint is not a documented, stable third-party completion API. Open client source does not guarantee third-party service compatibility or authorization. Verify service usage conditions separately.

## 7. Implementation guidance

Worth adapting:

- Debounce and cancellation.
- Request identity and stale-response protection.
- Prefix/suffix prompt construction.
- Typed-through suggestion reuse.
- Completion trimming and overlap handling.

Avoid copying without demonstrated need:

- VS Code's dependency injection and service infrastructure.
- Full JSX-based prompt renderer.
- Code-oriented similar-file retrieval.
- Telemetry and feature-experiment systems.
- VS Code-specific authentication/session management.

Use the upstream implementation to understand individual behaviors, not as a dependency architecture to reproduce wholesale.

## 8. Primary source references

All paths are within `microsoft/vscode`, under `extensions/copilot/src/`.

- **Lifecycle and debounce:** `extension/completions-core/vscode-node/lib/src/ghostText/ghostText.ts`
- **Request strategy and network orchestration:** `extension/completions-core/vscode-node/lib/src/ghostText/completionsFromNetwork.ts`
- **Context composition:** `extension/completions-core/vscode-node/lib/src/prompt/components/splitContextPrompt.tsx`
- **Context resolution and token budgeting:** `extension/completions-core/vscode-node/lib/src/prompt/completionsPromptFactory/componentsCompletionsPromptFactory.tsx`
- **API serialization and response parsing:** `extension/completions-core/vscode-node/lib/src/openai/fetch.ts`
- **Authentication/token refresh:** `platform/authentication/vscode-node/copilotTokenManager.ts`

Source repository: https://github.com/microsoft/vscode/tree/main/extensions/copilot

These are implementation references, not stable public APIs. Reinspect upstream code when exact behavior matters.