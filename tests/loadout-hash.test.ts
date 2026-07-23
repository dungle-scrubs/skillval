import { describe, expect, it } from "vitest";
import { loadoutHash } from "../src/utils.js";

const member = (name: string, contentHash: string) => ({ contentHash, name });

describe("loadoutHash", () => {
  it("is order-independent: a loadout is a set, not a sequence", () => {
    expect(loadoutHash([member("a", "h1"), member("b", "h2")])).toBe(
      loadoutHash([member("b", "h2"), member("a", "h1")]),
    );
  });

  it("depends on member content: a skill arm's key tracks its skill's content", () => {
    expect(loadoutHash([member("a", "h1")])).not.toBe(loadoutHash([member("a", "h2")]));
    expect(loadoutHash([member("a", "h1"), member("b", "h2")])).not.toBe(
      loadoutHash([member("a", "h1")]),
    );
  });

  it("depends on member name: skills install under their names", () => {
    // Two identically-hashed skills with different names are different seeded environments.
    expect(loadoutHash([member("a", "h1")])).not.toBe(loadoutHash([member("b", "h1")]));
  });

  it("hashes the empty set to a stable value independent of any skill", () => {
    // The empty set is the no-skill baseline: its key must never change when a skill is edited.
    expect(loadoutHash([])).toBe(loadoutHash([]));
    expect(loadoutHash([])).not.toBe(loadoutHash([member("a", "h1")]));
  });
});
