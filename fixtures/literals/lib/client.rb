require "anthropic"

client = Anthropic::Client.new
client.messages.create(model: "claude-3-haiku-20240307", max_tokens: 10, messages: [])
puts "https://api.anthropic.com/v1/messages"
