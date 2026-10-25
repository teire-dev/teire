from anthropic import AI_PROMPT, HUMAN_PROMPT, Anthropic

MODEL = "claude-3-5-sonnet-20241022"


def legacy_complete(client: Anthropic, prompt: str) -> str:
    result = client.completions.create(model="claude-2.1", max_tokens_to_sample=200, prompt=f"{HUMAN_PROMPT} {prompt}{AI_PROMPT}")
    return result.completion


def summarise(text: str) -> str:
    client = Anthropic(api_key="test")
    msg = client.messages.create(
        model=MODEL,
        max_tokens=512,
        temperature=0.2,
        messages=[{"role": "user", "content": text}],
    )
    return msg.content[0].text


class Cache:
    def create(self, **kwargs):
        return kwargs


def decoy() -> dict:
    messages = Cache()
    return messages.create(temperature=1)
