import { describe, expect, it } from "vitest";
import type { SkillvalConfig } from "../src/config.js";
import type { DiscoveredSkill, DiscoveryResult } from "../src/discovery.js";
import { LoadoutError, resolveLoadout } from "../src/loadout.js";

const readySkill = (name: string, root = "/root"): DiscoveredSkill =>
  ({
    caseCount: 0,
    class: "preference",
    hasSkillval: true,
    name,
    root,
    skillDirectory: `${root}/${name}`,
    status: "ready",
  }) as DiscoveredSkill;

const discovery = (names: string[]): DiscoveryResult => ({
  missingRoots: [],
  skills: names.map((name) => readySkill(name)),
});

const config = (loadouts: Record<string, string[]>): SkillvalConfig => ({
  executor: "codex",
  loadouts,
  roots: ["/root"],
});

describe("resolveLoadout", () => {
  it("resolves member names to their discovered skill directories", () => {
    const resolved = resolveLoadout(
      config({ everyday: ["alpha", "beta"] }),
      "everyday",
      discovery(["alpha", "beta", "gamma"]),
    );

    expect(resolved).toEqual({
      members: [
        { directory: "/root/alpha", name: "alpha" },
        { directory: "/root/beta", name: "beta" },
      ],
      name: "everyday",
      warnings: [],
    });
  });

  it("warns and keeps the first match when a member name collides across roots", () => {
    const resolved = resolveLoadout(config({ everyday: ["alpha"] }), "everyday", {
      missingRoots: [],
      skills: [readySkill("alpha", "/root-a"), readySkill("alpha", "/root-b")],
    });

    expect(resolved.members).toEqual([{ directory: "/root-a/alpha", name: "alpha" }]);
    expect(resolved.warnings).toEqual([
      'loadout "everyday" member "alpha" matches 2 discovered skills; using /root-a/alpha, ' +
        "ignoring /root-b/alpha",
    ]);
  });

  it("does not warn when each member name matches exactly one skill", () => {
    const resolved = resolveLoadout(
      config({ everyday: ["alpha", "beta"] }),
      "everyday",
      discovery(["alpha", "beta"]),
    );

    expect(resolved.warnings).toEqual([]);
  });

  it("rejects an unknown loadout name and lists the configured ones", () => {
    expect(() =>
      resolveLoadout(config({ everyday: ["alpha"] }), "weekend", discovery(["alpha"])),
    ).toThrow('unknown loadout "weekend"; configured loadouts: everyday');
  });

  it("reports that no loadouts are configured when the map is empty", () => {
    expect(() => resolveLoadout(config({}), "everyday", discovery(["alpha"]))).toThrow(
      "no loadouts are configured",
    );
  });

  it("rejects a member that is not a discovered skill", () => {
    expect(() =>
      resolveLoadout(config({ everyday: ["alpha", "ghost"] }), "everyday", discovery(["alpha"])),
    ).toThrow(LoadoutError);
    expect(() =>
      resolveLoadout(config({ everyday: ["ghost"] }), "everyday", discovery(["alpha"])),
    ).toThrow('member "ghost" is not a discovered skill');
  });

  it("treats an inherited object key as an unknown loadout, not a TypeError", () => {
    expect(() =>
      resolveLoadout(config({ everyday: ["alpha"] }), "toString", discovery(["alpha"])),
    ).toThrow(LoadoutError);
    expect(() =>
      resolveLoadout(config({ everyday: ["alpha"] }), "__proto__", discovery(["alpha"])),
    ).toThrow('unknown loadout "__proto__"');
  });

  it("resolves with no loadouts key present as unknown", () => {
    const bare: SkillvalConfig = { executor: "codex", roots: ["/root"] };

    expect(() => resolveLoadout(bare, "everyday", discovery(["alpha"]))).toThrow(
      "no loadouts are configured",
    );
  });
});
