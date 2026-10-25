package main

import "fmt"

type Request struct{ Model string }

func main() {
	req := Request{Model: "gpt-4-0613"}
	url := `https://api.anthropic.com/v1/messages`
	fmt.Println(req, url, "claude-3-haiku-20240307")
}
