/** Resolves a named config loadout to the discovered skills it seeds. */
import type { SkillvalConfig } from "./config.js";
import type { DiscoveredSkill, DiscoveryResult } from "./discovery.js";

// A loadout member: a discovered skill's name and the directory holding its SKILL.md, ready to seed.
export interface LoadoutMember {
  readonly directory: string;
  readonly name: string;
}

export interface ResolvedLoadout {
  readonly members: readonly LoadoutMember[];
  readonly name: string;
}

export class LoadoutError extends Error {
  public readonly code = "LOADOUT_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "LoadoutError";
  }
}

// A loadout member only needs to be seedable (a discovered SKILL.md), not evaluatable, so any
// discovered skill qualifies regardless of whether it has a valid skillval.yml.
export function resolveLoadout(
  config: SkillvalConfig,
  name: string,
  discovery: DiscoveryResult,
): ResolvedLoadout {
  const loadouts = config.loadouts ?? {};
  // Own-property check so an inherited key such as "toString" or "__proto__" resolves as unknown
  // rather than returning an Object.prototype value and throwing a raw TypeError downstream.
  const memberNames = Object.hasOwn(loadouts, name) ? loadouts[name] : undefined;
  if (memberNames === undefined) {
    const configured = Object.keys(loadouts);
    const suffix =
      configured.length === 0
        ? "no loadouts are configured"
        : `configured loadouts: ${configured.join(", ")}`;
    throw new LoadoutError(`unknown loadout "${name}"; ${suffix}`);
  }

  const byName = new Map<string, DiscoveredSkill>();
  for (const skill of discovery.skills) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }

  const members = memberNames.map((member): LoadoutMember => {
    const skill = byName.get(member);
    if (skill === undefined) {
      throw new LoadoutError(`loadout "${name}" member "${member}" is not a discovered skill`);
    }
    return { directory: skill.skillDirectory, name: skill.name };
  });

  return { members, name };
}
