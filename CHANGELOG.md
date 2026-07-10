## v2.1.3 (2026-07-10)

### Bug Fixes

* fix: repair supera.json config and README badge (#75) (6eee0d4939a4f94de244dcf837dc427034a71718)

## v2.1.2 (2026-07-09)



## v2.1.1 (2026-07-09)

### Bug Fixes

* fix: SendMessage guard and worktree cleanup cd fix (#71) (1d362ecdde90fb3afc1b2e91495db6ba4497e0b0)

## v2.1.0 (2026-07-08)

### Features

* feat: harden ship/pr-watch with verification gates, bug fixes, and insights skill (fd88522ccd380afa86f8df74efc91a3de9581249)

## v2.0.4 (2026-07-08)

### Bug Fixes

* fix: cd back to repo root after worktree cleanup (#69) (024fd0dc159228a410a6f4e5b081d345acd55888)

## v2.0.3 (2026-07-08)

### Bug Fixes

* fix(ship): drop rm -rf fallback from worktree cleanup to avoid permission prompt (1a34f195f84ac0f3f13d5c46dfe853fd98025439)

## v2.0.2 (2026-07-08)

### Bug Fixes

* fix(ship): use rm -rf instead of rmdir for stale worktree cleanup (dd350c9bd784e2745a1f25e3f2b0dd8a2c329c5a)

## v2.0.1 (2026-07-08)

### Bug Fixes

* fix: guard rmdir with non-empty slug check to prevent permission prompt (#68) (3f0db374257e56748314ca1e2dee0e46839de4da)

## v2.0.0 (2026-07-08)

### ⚠ BREAKING CHANGES

* feat!: ship goes end-to-end — commit, push, PR, pr-watch handoff (01616a4054cd2199c6fab9171c8b2e81cf80c7ce)
* refactor!: strip to lean worktree-based plugin (331894751a827eb38312179fc71e9c967ba27fb8)

### Features

* feat!: ship goes end-to-end — commit, push, PR, pr-watch handoff (01616a4054cd2199c6fab9171c8b2e81cf80c7ce)

### Bug Fixes

* fix(ship): avoid rm -rf permission prompt on worktree cleanup (a5a79ff5b6ae75fb3aaa6f1edc1b2f29f0f8f1d4)

### Documentation

* docs(readme): rewrite following heronlabs house style (ea55bf30d9323eb6f0f3b3c8e02e8195036c1204)

### Miscellaneous Chores

* other: [skip ci] sync plugin v1.0.3 (36d45798da480e755d2e6455d14117ca0d726362)

