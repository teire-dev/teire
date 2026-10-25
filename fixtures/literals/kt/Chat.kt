fun run(): String {
    val params = ChatCompletionCreateParams.builder().model("gpt-4-0613").build()
    return "plain text gpt-4-0613"
}
