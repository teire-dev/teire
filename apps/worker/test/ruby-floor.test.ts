import { describe, expect, it } from "vitest";
import { rubyIsTheOnlyCause } from "../src/jobs/fix";

// Review R7: the Ruby-floor fallback applies only when Ruby is the sole cause of the refusal.
describe("Ruby floor as the only cause", () => {
  it("accepts bristow's refusal, where every clause is about Ruby", () => {
    const message = `Could not find compatible versions

Because every version of bristow depends on anthropic ~> 1.0
  and anthropic >= 1.0.0 depends on Ruby >= 3.2.0,
  every version of bristow requires Ruby >= 3.2.0.
So, because Gemfile depends on bristow >= 0
  and current Ruby version is = 3.0.7,
  version solving has failed.`;
    expect(rubyIsTheOnlyCause(message)).toBe(true);
  });

  it("refuses when another incompatibility is in the chain", () => {
    const message = `Because every version of rails depends on rack < 3
  and every version of sinatra depends on rack >= 3, rails is incompatible with sinatra.
And because current Ruby version is = 3.0.7 and sinatra requires Ruby >= 3.2.0,
  version solving has failed.`;
    expect(rubyIsTheOnlyCause(message)).toBe(false);
  });

  it("refuses one clause that mixes the Ruby floor with a gem conflict (stage R review)", () => {
    const message = `Because every version of rails depends on rack < 3 and every version of sinatra depends on rack >= 3
  and current Ruby version is = 3.0.7, version solving has failed.`;
    expect(rubyIsTheOnlyCause(message)).toBe(false);
  });
});
