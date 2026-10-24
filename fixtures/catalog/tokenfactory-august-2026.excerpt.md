> ## Documentation Index
>
> Fetch the complete documentation index at: https://docs.tokenfactory.nebius.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Model Deprecations: August 2026

> Models soon leaving Token Factory Serverless with recommended migration paths.

> [!NOTE]
>
> **On August 31, 2026:**
>
> - Affected Serverless models will no longer be available via API or Playground.
> - Dedicated Endpoints for these models will be unaffected by this change.

## What to Know

These models will be removed from Token Factory on **August 31, 2026**. After that date, you will not be able to select them in the Playground or send API requests using their model IDs.
- This change only affects Serverless usage. [Dedicated Endpoints](https://tokenfactory.nebius.com/endpoints/create-dedicated-endpoint) are unaffected.
- Token Factory does not automatically reroute requests from deprecated models.
- Choose a replacement based on your workload, then test before migrating traffic.

| Deprecating Model                                                                                                                               | Recommended Replacement                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [`deepseek-ai/DeepSeek-V4-Flash`](https://tokenfactory.nebius.com/models/catalog/text2text/deepseek-ai%2FDeepSeek-V4-Flash)                     | [`deepseek-ai/DeepSeek-V4-Flash-0731`](https://tokenfactory.nebius.com/?modals=endpoint-details\&model-id=deepseek-ai/DeepSeek-V4-Flash-0731) |
| [`meta-llama/Llama-3.3-70B-Instruct`](https://tokenfactory.nebius.com/models/catalog/text2text/meta-llama%2FLlama-3.3-70B-Instruct)             | [`nvidia/Nemotron-3_5-Lightning`](https://tokenfactory.nebius.com/models/catalog/text2text/nvidia%2FNemotron-3_5-Lightning)                   |
| [`MiniMaxAI/MiniMax-M2.5`](https://tokenfactory.nebius.com/models/catalog/text2text/MiniMaxAI%2FMiniMax-M2.5)                                   | [`MiniMaxAI/MiniMax-M3`](https://tokenfactory.nebius.com/models/catalog/text2text/MiniMaxAI%2FMiniMax-M3)                                     |
| [`NousResearch/Hermes-4-70B`](https://tokenfactory.nebius.com/models/catalog/text2text/NousResearch%2FHermes-4-70B)                             | [`nvidia/Nemotron-3_5-Lightning`](https://tokenfactory.nebius.com/models/catalog/text2text/nvidia%2FNemotron-3_5-Lightning)                   |
| [`nvidia/Cosmos3-Super-Reasoner`](https://tokenfactory.nebius.com/models/catalog/image2text/nvidia%2FCosmos3-Super-Reasoner)                    | [`MiniMaxAI/MiniMax-M3`](https://tokenfactory.nebius.com/models/catalog/text2text/MiniMaxAI%2FMiniMax-M3)                                     |
| [`nvidia/Llama-3_1-Nemotron-Ultra-253B-v1`](https://tokenfactory.nebius.com/models/catalog/text2text/nvidia%2FLlama-3_1-Nemotron-Ultra-253B-v1) | [`nvidia/nemotron-3-super-120b-a12b`](https://tokenfactory.nebius.com/models/catalog/text2text/nvidia%2Fnemotron-3-super-120b-a12b)           |
| [`nvidia/Nemotron-3-Nano-Omni`](https://tokenfactory.nebius.com/models/catalog/text2text/nvidia%2FNemotron-3-Nano-Omni)                         | [`nvidia/Nemotron-3_5-Lightning`](https://tokenfactory.nebius.com/models/catalog/text2text/nvidia%2FNemotron-3_5-Lightning)                   |
| [`Qwen/Qwen2.5-VL-72B-Instruct`](https://tokenfactory.nebius.com/models/catalog/image2text/Qwen%2FQwen2.5-VL-72B-Instruct)                      | [`MiniMaxAI/MiniMax-M3`](https://tokenfactory.nebius.com/models/catalog/text2text/MiniMaxAI%2FMiniMax-M3)                                     |
| [`Qwen/Qwen3-32B`](https://tokenfactory.nebius.com/models/catalog/text2text/Qwen%2FQwen3-32B)                                                   | [`nvidia/Nemotron-3_5-Lightning`](https://tokenfactory.nebius.com/models/catalog/text2text/nvidia%2FNemotron-3_5-Lightning)                   |
| [`Qwen/Qwen3-Next-80B-A3B-Thinking`](https://tokenfactory.nebius.com/models/catalog/text2text/Qwen%2FQwen3-Next-80B-A3B-Thinking)               | [`Qwen/Qwen3.5-397B-A17B`](https://tokenfactory.nebius.com/models/catalog/text2text/Qwen%2FQwen3.5-397B-A17B)                                 |
