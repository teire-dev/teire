class Chat {
  String run() {
    var params = ChatCompletionCreateParams.builder().model("gpt-4-0613").build();
    return "https://api.openai.com/v1/chat/completions";
  }
}
