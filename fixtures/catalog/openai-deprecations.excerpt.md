# Deprecations (excerpt for tests)

## Deprecation history

### 2026-04-22: Legacy GPT model snapshots

On April 22, 2026, we announced the deprecation of the following older OpenAI models. Access to these models was shut down on October 23, 2026.

| Shutdown date    | Model snapshot                                                         | Substitute model                                  |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| October 23, 2026 | `gpt-3.5-turbo-0125` \| `gpt-3.5-turbo`, `gpt-3.5-turbo-completions`   | `gpt-5.6-terra`                                   |
| October 23, 2026 | `gpt-4-0613` \| `gpt-4`, `gpt-4-0613-completions`, `gpt-4-completions` | `gpt-5.6-sol`                                     |
| October 23, 2026 | `gpt-4-1106-preview`                                                   | `gpt-5.6-sol`                                     |
| October 23, 2026 | `gpt-4-turbo` \| `gpt-4-turbo-2024-04-09`, `gpt-4-turbo-completions`   | `gpt-5.6-sol`                                     |
| October 23, 2026 | `gpt-4.1-nano` \| `gpt-4.1-nano-2025-04-14`                            | `gpt-5.6-luna`                                    |
| October 23, 2026 | `gpt-4o-2024-05-13`                                                    | `gpt-5.6-sol`                                     |
| October 23, 2026 | `gpt-image-1`                                                          | `gpt-image-2.5-sunburst` or `gpt-image-2.5-flare` |
| October 23, 2026 | `o1-2024-12-17` \| `o1`                                                | `gpt-5.6-sol`                                     |
| October 23, 2026 | `o1-pro-2025-03-19` \| `o1-pro`                                        | `gpt-5.6-sol` (`reasoning.mode: pro`)             |
| October 23, 2026 | `o3-mini-2025-01-31` \| `o3-mini`                                      | `gpt-5.6-sol`                                     |
| October 23, 2026 | `ft-o4-mini-2025-04-16`                                                | `gpt-5.6-terra`                                   |
| October 23, 2026 | `o4-mini-2025-04-16` \| `o4-mini`                                      | `gpt-5.6-terra`                                   |

The following fine-tuned versions were also shut down on October 23, 2026:

| Shutdown date    | Model snapshot               | Recommended replacement base model |
| ---------------- | ---------------------------- | ---------------------------------- |
| October 23, 2026 | `ft-gpt-3.5-turbo`           | `gpt-5.6-terra`                    |
| October 23, 2026 | `ft-gpt-4`                   | `gpt-5.6-sol`                      |
| October 23, 2026 | `ft-gpt-4.1-nano-2025-04-14` | `gpt-5.6-luna`                     |
| October 23, 2026 | `ft-babbage-002`             | `gpt-5.6-terra`                    |
| October 23, 2026 | `ft-davinci-002`             | `gpt-5.6-terra`                    |


### 2025-09-15: Realtime API Beta

The Realtime API Beta was deprecated and removed from the API on May 12, 2026.

The interfaces in the Realtime beta API and the released GA API have a few key differences. See [the migration guide](https://developers.openai.com/api/docs/guides/realtime#beta-to-ga-migration) for the current GA interface and related Realtime docs.

| Shutdown date | Model / system           | Recommended replacement |
| ------------- | ------------------------ | ----------------------- |
| 2026‑05‑12    | OpenAI-Beta: realtime=v1 | Realtime API            |


### 2022-06-03: Legacy endpoints

| Shutdown date | System                | Recommended replacement                                                                               |
| ------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| 2022-12-03    | `/v1/engines`         | [/v1/models](https://platform.openai.com/docs/api-reference/models/list)                              |
| 2022-12-03    | `/v1/search`          | [View transition guide](https://help.openai.com/en/articles/6272952-search-transition-guide)          |
| 2022-12-03    | `/v1/classifications` | [View transition guide](https://help.openai.com/en/articles/6272941-classifications-transition-guide) |
| 2022-12-03    | `/v1/answers`         | [View transition guide](https://help.openai.com/en/articles/6233728-answers-transition-guide)         |
