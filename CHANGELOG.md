# Changelog

## [0.4.0](https://github.com/dungle-scrubs/skillval/compare/skillval-v0.3.0...skillval-v0.4.0) (2026-07-28)


### Features

* add --dry-run cost preview ([#30](https://github.com/dungle-scrubs/skillval/issues/30)) ([8715183](https://github.com/dungle-scrubs/skillval/commit/871518355e7fe4619fe3828e67bc71223c26a6e1))
* assert.ast - structural grading via ast-grep ([#43](https://github.com/dungle-scrubs/skillval/issues/43)) ([0ca16f5](https://github.com/dungle-scrubs/skillval/commit/0ca16f5692b213d73b7973e36b8149f1f401350c))
* bundle skillval-coverage skill ([#32](https://github.com/dungle-scrubs/skillval/issues/32)) ([b2d0993](https://github.com/dungle-scrubs/skillval/commit/b2d0993590fb8bdf5e6a80511f76650934492871))
* config loadouts and resolveLoadout ([#23](https://github.com/dungle-scrubs/skillval/issues/23)) ([f160ab7](https://github.com/dungle-scrubs/skillval/commit/f160ab77b78117f0c8ed321e6c6af2e4f5a7356a))
* **config:** pin model and effort so a verdict is attributable ([#55](https://github.com/dungle-scrubs/skillval/issues/55)) ([6a852d8](https://github.com/dungle-scrubs/skillval/commit/6a852d80988c67c4e4445fedb684cc68d3f688dc))
* coverage command + React/Tailwind/shadcn report UI with teaching layer ([#41](https://github.com/dungle-scrubs/skillval/issues/41)) ([0d05e82](https://github.com/dungle-scrubs/skillval/commit/0d05e82ff2eecb5fe49fbe714e44a7e3fd00dfba))
* evaluate agent instruction files with single-rule ablation ([#31](https://github.com/dungle-scrubs/skillval/issues/31)) ([dda279b](https://github.com/dungle-scrubs/skillval/commit/dda279b5488d193d7590fc48fe4558c8fa9d37e4))
* exclude skills from discovery by name ([#33](https://github.com/dungle-scrubs/skillval/issues/33)) ([b32ef7b](https://github.com/dungle-scrubs/skillval/commit/b32ef7ba165ec48038998d3a03121f2122d606ad))
* **executors:** structured trigger detection for pi, hardened for codex ([#39](https://github.com/dungle-scrubs/skillval/issues/39)) ([829832a](https://github.com/dungle-scrubs/skillval/commit/829832a7e97b24d01984247f04893f8ff410a1a0))
* gate case-authored shell behind --allow-shell, off by default ([#29](https://github.com/dungle-scrubs/skillval/issues/29)) ([a4f5b07](https://github.com/dungle-scrubs/skillval/commit/a4f5b07c4fe891e216f84e47eba62e30d27d158d))
* group mode - marginal effect within a loadout (loadout mode, PR 4b) ([#25](https://github.com/dungle-scrubs/skillval/issues/25)) ([593bc64](https://github.com/dungle-scrubs/skillval/commit/593bc6404870973330ccb94251e2d5f6e67a0b74))
* isolate the solo arm and rename skill -&gt; solo ([#24](https://github.com/dungle-scrubs/skillval/issues/24)) ([bcff680](https://github.com/dungle-scrubs/skillval/commit/bcff680a68704cc74ce314caea7414047a4d29dd))
* key the cache on a loadout hash of the seeded skill set ([#22](https://github.com/dungle-scrubs/skillval/issues/22)) ([7cbd1d7](https://github.com/dungle-scrubs/skillval/commit/7cbd1d7979f59e272be315acaef5f4f366ff42e3))
* profile.targets - dead weight is relative to the tiers you actually run ([#52](https://github.com/dungle-scrubs/skillval/issues/52)) ([ea6161f](https://github.com/dungle-scrubs/skillval/commit/ea6161fea7c5c0c8d7bc02d6ae66833a1803f635))
* seed a set of skills per trial instead of a single skill ([#20](https://github.com/dungle-scrubs/skillval/issues/20)) ([48869ee](https://github.com/dungle-scrubs/skillval/commit/48869ee9c330932c71bec7eb866f89b76972211d))
* skillval ledger - cross-run verdict matrix by executor identity ([#49](https://github.com/dungle-scrubs/skillval/issues/49)) ([8be8387](https://github.com/dungle-scrubs/skillval/commit/8be838745b4d0cc5a948fc6e3d9cd1a39d272283))
* **skillval-coverage:** audit test quality, not just coverage; bound actions by confidence ([#48](https://github.com/dungle-scrubs/skillval/issues/48)) ([24f9ed5](https://github.com/dungle-scrubs/skillval/commit/24f9ed5bdc15c2488b53fecf70f78dc44b6db45c))
* thread an explicit inconclusive verdict through case, summary, and reports ([#38](https://github.com/dungle-scrubs/skillval/issues/38)) ([bb24933](https://github.com/dungle-scrubs/skillval/commit/bb249336c72cdf966c40293646b63c947588d449))
* warn on ambiguous loadout member name ([#28](https://github.com/dungle-scrubs/skillval/issues/28)) ([df6014f](https://github.com/dungle-scrubs/skillval/commit/df6014f97a33febcaee0ca3b27a231b4e0aecd07))


### Bug Fixes

* ast got: excerpts and per-case report identity ([#46](https://github.com/dungle-scrubs/skillval/issues/46)) ([6977f1e](https://github.com/dungle-scrubs/skillval/commit/6977f1eda71cb2111881f8cc10c92b18bd2a0fde))
* **cli:** report opening is opt-in via --open, not automatic ([#51](https://github.com/dungle-scrubs/skillval/issues/51)) ([e47b573](https://github.com/dungle-scrubs/skillval/commit/e47b573125cbcf7502c81544d790819401c0e585))
* close pi's stdin so trials do not hang ([#34](https://github.com/dungle-scrubs/skillval/issues/34)) ([02df0b8](https://github.com/dungle-scrubs/skillval/commit/02df0b8dc253d3966014132c396595867b7bf545))
* do not attribute interference when the peers arm also fails ([#27](https://github.com/dungle-scrubs/skillval/issues/27)) ([f38c787](https://github.com/dungle-scrubs/skillval/commit/f38c78715339e2e0a6e930571d46656b0d51eb92))
* **executors:** a run that graded nothing is not a verdict ([#54](https://github.com/dungle-scrubs/skillval/issues/54)) ([9c5e16a](https://github.com/dungle-scrubs/skillval/commit/9c5e16a9f09ca4a2161d7dc16485657b5ee41af2))
* **executors:** cap agent stdout, classify overflow as infrastructure ([#37](https://github.com/dungle-scrubs/skillval/issues/37)) ([1a74e80](https://github.com/dungle-scrubs/skillval/commit/1a74e809f4e69266093b3259bfd53dc3491a0d79))
* **executors:** provider-availability failures are infrastructure, not content verdicts ([#47](https://github.com/dungle-scrubs/skillval/issues/47)) ([0dba50b](https://github.com/dungle-scrubs/skillval/commit/0dba50b51e6cfda087ae1d4e361ae55f89fd436d))
* **executors:** stage skills without their eval definition - the graded arm could read its own answer key ([#50](https://github.com/dungle-scrubs/skillval/issues/50)) ([958e365](https://github.com/dungle-scrubs/skillval/commit/958e36530f0dc936c1cd49e3553f312c89e52fda))
* **grade:** a must_not_match failure names what it matched ([#57](https://github.com/dungle-scrubs/skillval/issues/57)) ([c01d570](https://github.com/dungle-scrubs/skillval/commit/c01d5703348b35f7e653f2e4efdc90cf331bdc07))
* **grade:** never grade a seeded skill as model output ([#60](https://github.com/dungle-scrubs/skillval/issues/60)) ([23042d5](https://github.com/dungle-scrubs/skillval/commit/23042d58752686411cf06b5b755ac0a17cf15572))
* harden the grading tree and contain the agent process group ([#73](https://github.com/dungle-scrubs/skillval/issues/73)) ([8317aeb](https://github.com/dungle-scrubs/skillval/commit/8317aeb37e3afa474ac059082b5d0f78952fc42c))
* **pi:** agent_end alone is not a completed turn; document the rest ([#64](https://github.com/dungle-scrubs/skillval/issues/64)) ([58406fc](https://github.com/dungle-scrubs/skillval/commit/58406fc0e346461b09b2c4751198438e921ba642))
* **report-ui:** drawer transitions, wider evidence sheet, structured code formatting ([#44](https://github.com/dungle-scrubs/skillval/issues/44)) ([5df2358](https://github.com/dungle-scrubs/skillval/commit/5df2358c8f57d49fa249782057adbf301808fa48))
* **runner:** grade from a snapshot instead of deleting staged files ([#69](https://github.com/dungle-scrubs/skillval/issues/69)) ([2f6128f](https://github.com/dungle-scrubs/skillval/commit/2f6128f73812115f8606a663ae085e67e792fb2b))
* **runner:** make the graded tree faithful, and stand it at the workspace path ([#72](https://github.com/dungle-scrubs/skillval/issues/72)) ([2b003ec](https://github.com/dungle-scrubs/skillval/commit/2b003ece772fbd328f912d03376fcf67220f3534))
* **runner:** remove staged skills before grading, not just from regex text ([#61](https://github.com/dungle-scrubs/skillval/issues/61)) ([aa0c01d](https://github.com/dungle-scrubs/skillval/commit/aa0c01d2a680e99b05b40a5d1fb99fc385a41cf4))
* second-review findings - my pi fix never ran, and two tests could not fail ([#65](https://github.com/dungle-scrubs/skillval/issues/65)) ([8eef2f1](https://github.com/dungle-scrubs/skillval/commit/8eef2f11aeb51264a2968fbd2f1322b4c62e30b7))
* **seed:** rewrite frontmatter through the YAML document, not a line delete ([#67](https://github.com/dungle-scrubs/skillval/issues/67)) ([6ca0e58](https://github.com/dungle-scrubs/skillval/commit/6ca0e584df9ced5f5f7f0bba122baf0db88414b0))
* **seed:** splice the opt-out by source range; cleanup can no longer vote ([#71](https://github.com/dungle-scrubs/skillval/issues/71)) ([6cdfc70](https://github.com/dungle-scrubs/skillval/commit/6cdfc7005946e106816af0e141bc1a4d32fe0d90))
* **seed:** stage skills by copy - codex cannot see a symlinked SKILL.md ([#59](https://github.com/dungle-scrubs/skillval/issues/59)) ([509354b](https://github.com/dungle-scrubs/skillval/commit/509354bce94e5440918f29225ccd61c60aa82ba9))
* **seed:** stage user-invoked skills so their cases can fail ([#58](https://github.com/dungle-scrubs/skillval/issues/58)) ([033a851](https://github.com/dungle-scrubs/skillval/commit/033a85192b2ab5ea3b3e45304f73c7202adeef1a))
* separate staging lifecycle from the provider trace, degrade bad skills ([#70](https://github.com/dungle-scrubs/skillval/issues/70)) ([2bf0f50](https://github.com/dungle-scrubs/skillval/commit/2bf0f501fb408702384a28f264d7ee10ffa5caac))
* **skillval-coverage:** apostrophe pattern + trigger boundary; prune two cross-model no-ops ([#42](https://github.com/dungle-scrubs/skillval/issues/42)) ([a53102f](https://github.com/dungle-scrubs/skillval/commit/a53102fdef5f2a75a54647ceb199f208b16e7a98))
* surgical teardown, and pi completion fails closed ([#66](https://github.com/dungle-scrubs/skillval/issues/66)) ([4d75d19](https://github.com/dungle-scrubs/skillval/commit/4d75d19a482f4e9126ad4b216e72d9920f90c7c3))
* third-review findings - teardown rebuilt around an immutable manifest ([#68](https://github.com/dungle-scrubs/skillval/issues/68)) ([2b830b5](https://github.com/dungle-scrubs/skillval/commit/2b830b50dbac5b5b937aff58cffbdf9809f8717e))
* three more review findings, two reproduced at runtime first ([#63](https://github.com/dungle-scrubs/skillval/issues/63)) ([a9a6edb](https://github.com/dungle-scrubs/skillval/commit/a9a6edbba7b6ccc1453bfc7fe9532d7287302394))
* three review findings, each reproduced at runtime first ([#62](https://github.com/dungle-scrubs/skillval/issues/62)) ([e7ea3d7](https://github.com/dungle-scrubs/skillval/commit/e7ea3d7a5ec52ad4d71ca0023b3a91fabccea66a))

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
