fn main() {
    let request = CreateChatCompletionRequestArgs::default().model("gpt-4-0613").build();
    let host = "https://api.openai.com/v1";
    println!("{:?} {}", request, host);
}
