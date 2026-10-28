import { describe, expect, it } from "vitest";
import { apiHostsInTexts } from "../src/discover/sdk";
import { escapeModulePath } from "../src/discover/sdk-sources";

// SDK host discovery in every ecosystem (S16.1): sources read as text from each registry's archive.
describe("SDK sources", () => {
  it("escapes Go module paths for the proxy", () => {
    expect(escapeModulePath("github.com/Azure/azure-sdk-for-go")).toBe("github.com/!azure/azure-sdk-for-go");
  });

  it("counts API hosts in code, not in tests or examples", () => {
    const { hosts, files } = apiHostsInTexts([
      {
        path: "client.go",
        text: 'const base = "https://api.cohere.com/v2"\nurl := "https://api.cohere.com/v2/chat"',
      },
      { path: "testdata/mock.go", text: '"https://api.example-mock.com/v1"' },
      { path: "examples/main.rs", text: '"https://api.other.com/v1"' },
    ]);
    expect(hosts).toEqual([{ host: "api.cohere.com", count: 2 }]);
    expect(files).toBe(1);
  });
});
