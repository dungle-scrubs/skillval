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
  // Non-fatal notices for the caller to surface, one per member name that matched more than one
  // discovered skill. Resolution still proceeds with the first match; the warning names what won and
  // what was shadowed so a silent collision never decides membership unseen.
  readonly warnings: readonly string[];
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

  // Every discovered skill per name, in discovery order, so a member that matches more than one can
  // be surfaced. The first match still wins, preserving prior first-match-wins behavior exactly.
  const byName = new Map<string, DiscoveredSkill[]>();
  for (const skill of discovery.skills) {
    const matches = byName.get(skill.name);
    if (matches === undefined) byName.set(skill.name, [skill]);
    else matches.push(skill);
  }

  const warnings: string[] = [];
  const members = memberNames.map((member): LoadoutMember => {
    const matches = byName.get(member);
    if (matches === undefined || matches.length === 0) {
      throw new LoadoutError(`loadout "${name}" member "${member}" is not a discovered skill`);
    }
    const [winner, ...shadowed] = matches;
    if (winner === undefined) {
      throw new LoadoutError(`loadout "${name}" member "${member}" is not a discovered skill`);
    }
    if (shadowed.length > 0) {
      warnings.push(
        `loadout "${name}" member "${member}" matches ${matches.length} discovered skills; ` +
          `using ${winner.skillDirectory}, ignoring ${shadowed
            .map((skill) => skill.skillDirectory)
            .join(", ")}`,
      );
    }
    return { directory: winner.skillDirectory, name: winner.name };
  });

  return { members, name, warnings };
}
