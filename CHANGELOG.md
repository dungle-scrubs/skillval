# Changelog

## [0.4.0](https://github.com/dungle-scrubs/skillval/compare/skillval-v0.3.0...skillval-v0.4.0) (2026-07-24)


### Features

* add --dry-run cost preview ([#30](https://github.com/dungle-scrubs/skillval/issues/30)) ([8715183](https://github.com/dungle-scrubs/skillval/commit/871518355e7fe4619fe3828e67bc71223c26a6e1))
* bundle skillval-coverage skill ([#32](https://github.com/dungle-scrubs/skillval/issues/32)) ([b2d0993](https://github.com/dungle-scrubs/skillval/commit/b2d0993590fb8bdf5e6a80511f76650934492871))
* config loadouts and resolveLoadout ([#23](https://github.com/dungle-scrubs/skillval/issues/23)) ([f160ab7](https://github.com/dungle-scrubs/skillval/commit/f160ab77b78117f0c8ed321e6c6af2e4f5a7356a))
* evaluate agent instruction files with single-rule ablation ([#31](https://github.com/dungle-scrubs/skillval/issues/31)) ([dda279b](https://github.com/dungle-scrubs/skillval/commit/dda279b5488d193d7590fc48fe4558c8fa9d37e4))
* exclude skills from discovery by name ([#33](https://github.com/dungle-scrubs/skillval/issues/33)) ([b32ef7b](https://github.com/dungle-scrubs/skillval/commit/b32ef7ba165ec48038998d3a03121f2122d606ad))
* gate case-authored shell behind --allow-shell, off by default ([#29](https://github.com/dungle-scrubs/skillval/issues/29)) ([a4f5b07](https://github.com/dungle-scrubs/skillval/commit/a4f5b07c4fe891e216f84e47eba62e30d27d158d))
* group mode - marginal effect within a loadout (loadout mode, PR 4b) ([#25](https://github.com/dungle-scrubs/skillval/issues/25)) ([593bc64](https://github.com/dungle-scrubs/skillval/commit/593bc6404870973330ccb94251e2d5f6e67a0b74))
* isolate the solo arm and rename skill -&gt; solo ([#24](https://github.com/dungle-scrubs/skillval/issues/24)) ([bcff680](https://github.com/dungle-scrubs/skillval/commit/bcff680a68704cc74ce314caea7414047a4d29dd))
* key the cache on a loadout hash of the seeded skill set ([#22](https://github.com/dungle-scrubs/skillval/issues/22)) ([7cbd1d7](https://github.com/dungle-scrubs/skillval/commit/7cbd1d7979f59e272be315acaef5f4f366ff42e3))
* seed a set of skills per trial instead of a single skill ([#20](https://github.com/dungle-scrubs/skillval/issues/20)) ([48869ee](https://github.com/dungle-scrubs/skillval/commit/48869ee9c330932c71bec7eb866f89b76972211d))
* warn on ambiguous loadout member name ([#28](https://github.com/dungle-scrubs/skillval/issues/28)) ([df6014f](https://github.com/dungle-scrubs/skillval/commit/df6014f97a33febcaee0ca3b27a231b4e0aecd07))


### Bug Fixes

* close pi's stdin so trials do not hang ([#34](https://github.com/dungle-scrubs/skillval/issues/34)) ([02df0b8](https://github.com/dungle-scrubs/skillval/commit/02df0b8dc253d3966014132c396595867b7bf545))
* do not attribute interference when the peers arm also fails ([#27](https://github.com/dungle-scrubs/skillval/issues/27)) ([f38c787](https://github.com/dungle-scrubs/skillval/commit/f38c78715339e2e0a6e930571d46656b0d51eb92))

## [0.3.0](https://github.com/dungle-scrubs/skillval/compare/skillval-v0.2.0...skillval-v0.3.0) (2026-07-23)


### Features

* add command_exit grader for language-agnostic grading ([#12](https://github.com/dungle-scrubs/skillval/issues/12)) ([e312115](https://github.com/dungle-scrubs/skillval/commit/e312115dc99f53f061d1e2395ede35bc2dc1cfc6))
* add json_schema grader for validating produced files ([#11](https://github.com/dungle-scrubs/skillval/issues/11)) ([2990afe](https://github.com/dungle-scrubs/skillval/commit/2990afe76a60c41042a01518b5d913b333447f47))
* bump bundled TypeScript to 7 for the tsc grader ([#5](https://github.com/dungle-scrubs/skillval/issues/5)) ([986e95c](https://github.com/dungle-scrubs/skillval/commit/986e95c768c4f10f34ff53eb5849471681abe001))
* capture harness thinking level into executor identity ([#9](https://github.com/dungle-scrubs/skillval/issues/9)) ([372f3f4](https://github.com/dungle-scrubs/skillval/commit/372f3f4d8b2c5b73b1009513291099b06dd7183b))
* Claude Code executor ([#7](https://github.com/dungle-scrubs/skillval/issues/7)) ([eaa1af1](https://github.com/dungle-scrubs/skillval/commit/eaa1af1a51a832a84985878ade1d27045837e4ae))
* drop the skill hash from the baseline arm cache key ([#16](https://github.com/dungle-scrubs/skillval/issues/16)) ([d70444a](https://github.com/dungle-scrubs/skillval/commit/d70444aa574f99118782e0035eaa4edc966671d6))
* gate pi generation trials behind --allow-unsandboxed-pi ([#14](https://github.com/dungle-scrubs/skillval/issues/14)) ([10b609d](https://github.com/dungle-scrubs/skillval/commit/10b609d16ffef10f7d8432482b1819b13015d1ce))
* pi executor ([#8](https://github.com/dungle-scrubs/skillval/issues/8)) ([c67654d](https://github.com/dungle-scrubs/skillval/commit/c67654d7ef365a7ecb9572439e736da86952b4a6))
* record invocation-detection method in executor metadata ([#19](https://github.com/dungle-scrubs/skillval/issues/19)) ([ebe958b](https://github.com/dungle-scrubs/skillval/commit/ebe958b860725b5271c9d2e962ded60f5aedc80d))
* select model and effort per run with --model and --effort ([#13](https://github.com/dungle-scrubs/skillval/issues/13)) ([322e5fa](https://github.com/dungle-scrubs/skillval/commit/322e5fa7c2744fc3ff700aa2ef826718f35a7912))
* surface skill-invocation evidence and add trigger conformance tests ([#10](https://github.com/dungle-scrubs/skillval/issues/10)) ([789603f](https://github.com/dungle-scrubs/skillval/commit/789603f2955bf82fa00ee305a7be9a416a7b3c49))

## [0.2.0](https://github.com/dungle-scrubs/skillval/compare/skillval-v0.1.0...skillval-v0.2.0) (2026-07-22)


### Features

* workspace fixtures for realistic trial environments ([#3](https://github.com/dungle-scrubs/skillval/issues/3)) ([04a8a5e](https://github.com/dungle-scrubs/skillval/commit/04a8a5e01763fd77f08ce560c4aebdb7ad03f195))
