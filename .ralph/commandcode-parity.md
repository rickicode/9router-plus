# CommandCode Parity

Make the `commandcode` provider behave like the other providers across real Pi usage, including tool calling, codebase-aware analysis, and post-tool final answers.

## Goals
- Make `commandcode` tool-call behavior match other providers in real `pi` runs.
- Make code-analysis prompts behave like other providers instead of leaking pseudo-tool markup.
- Preserve already-fixed alias/model validation and request normalization behavior.
- Verify each fix with real tests against the local dev router on port `20129`.

## Checklist
- [x] Confirm current remaining failures in real `pi` flows.
- [x] Fix request-side message normalization for tool loops.
- [x] Fix request-side repo context so upstream sees real workspace metadata.
- [x] Fix response parsing for pseudo tool-call text emitted by `commandcode`.
- [ ] Fix post-tool final assistant answer handling so tool loops complete like other providers.
- [x] Add/expand regression tests for response parsing behavior.
- [x] Add/expand regression tests for post-tool completion behavior.
- [ ] Re-run real `pi` tests for `ccmd/deepseek/deepseek-v4-pro`.
- [ ] Re-run real `pi` tests for `ccmd/deepseek/deepseek-v4-flash`.
- [ ] Document parity status and any residual risks.

## Verification
- Real `pi` non-tool text test succeeded for `ccmd/deepseek/deepseek-v4-pro`.
- Real `pi` non-tool text test succeeded for `ccmd/deepseek/deepseek-v4-flash`.
- Real router OpenAI/Anthropic non-stream tests succeeded on `20129`.
- Real `pi` tool loop previously failed with `400 BAD_REQUEST`; fixed request normalization removed that error.
- Added parser fallback in `open-sse/translator/response/commandcode-to-openai.js` for pseudo `<tool_calls>` markup.
- `npm test -- tests/unit/commandcode-provider.test.js` passed after parser patch and continuation-shape patch.
- Real `pi` analysis prompt on `ccmd/deepseek/deepseek-v4-pro` now produces actual runtime tool calls (`bash`, `read`) instead of leaking literal `<tool_calls>...` text.
- Added response fallback in `open-sse/translator/response/commandcode-to-openai.js` to recover final text/tool blocks from `finish-step` / `finish` response payloads when `text-delta` is missing.
- Added regression test `recovers final assistant text from finish-step response blocks` in `tests/unit/commandcode-provider.test.js`.
- Added regression test `parses final assistant text from finish-step blocks in non-stream fallback` in `tests/unit/commandcode-provider.test.js` to prove `parseCommandCodeSSEToOpenAIResponse()` surfaces post-tool final text even without `text-delta` events.
- Updated the continuation-nudge regression to match the current translator behavior: the nudge text is appended to the same trailing `user` message that already contains the `tool_result` block.
- `npm test -- tests/unit/commandcode-provider.test.js` still passes after these regression additions.
- Current real-test blocker remains environmental, not parser-only:
  - direct inspection of `~/.9router/db.json` still shows zero `commandcode` connections (`[]`)
  - `pi --provider 9router-plus-dev --model ccmd/deepseek/deepseek-v4-pro --no-tools -p "Reply with exactly OK"` still fails with `404 No active credentials for provider: commandcode`
  - `pi --provider 9router-plus-dev --model ccmd/deepseek/deepseek-v4-flash --no-tools -p "Reply with exactly OK"` still fails with the same error
- Because there is still no active `commandcode` connection in the dev router database, real parity verification on port `20129` remains blocked before requests reach upstream/provider translation.

## Notes
- Response-side pseudo-tool parsing is parity-complete enough to execute tools in real `pi` flows when credentials are active.
- The only known product blocker left is post-tool final assistant completion after tool results, but it still cannot be re-verified until `commandcode` credentials are reactivated in the dev router instance.
- As soon as credentials are restored, the next step should be immediate real `pi` tool-loop reruns for both `ccmd/deepseek/deepseek-v4-pro` and `ccmd/deepseek/deepseek-v4-flash` to validate whether the new `finish-step`/`finish` fallback closes the final-answer gap.
