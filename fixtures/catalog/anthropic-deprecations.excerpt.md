# Model deprecations (excerpt for tests)

## Deprecation history

### 2026-04-14: Claude Sonnet 4 and Claude Opus 4 models

<Note>
  These models were retired June 15, 2026.
</Note>

On April 14, 2026, Anthropic notified developers using Claude Sonnet 4 and Claude Opus 4 models of their upcoming retirement on the Claude API.

| Retirement date | Deprecated model           | Recommended replacement |
| --------------- | -------------------------- | ----------------------- |
| June 15, 2026   | `claude-sonnet-4-20250514` | `claude-sonnet-5-5`     |
| June 15, 2026   | `claude-opus-4-20250514`   | `claude-opus-4-8`       |


## API parameter deprecations

Anthropic occasionally deprecates request parameters that no longer apply to current models. A new model can reject a deprecated parameter, and a new [API version](https://platform.claude.com/docs/en/api/versioning) can remove it for every model.

| Parameter                       | Status                                                                                                                  | Behavior                                                                                                                                                                         | Recommended replacement                                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `temperature`, `top_p`, `top_k` | Removed in [API version `2026-10-21`](https://platform.claude.com/docs/en/api/migration-2026-10-21#sampling-parameters) | Returns a 400 error. Earlier API versions return it when set to a non-default value on Claude 4.7 and later models and [Claude Mythos Preview](https://anthropic.com/glasswing). | Omit and use [prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) to guide model behavior. |

For migration steps, see [Migration guides](https://platform.claude.com/docs/en/about-claude/models/migration-guide).
