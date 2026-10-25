import os

from openai import OpenAI

MODEL_NAME = os.getenv("MODEL_NAME", "meta-llama/Llama-3.3-70B-Instruct")
client = OpenAI(base_url="https://api.tokenfactory.nebius.com/v1/")


def ask(q: str) -> str:
    out = client.chat.completions.create(model="nvidia/llama-3.1-nemotron-ultra-253b-v1", messages=[{"role": "user", "content": q}])
    note = "nvidia/llama-3.1-nemotron-ultra-253b-v1"
    return out.choices[0].message.content + note
