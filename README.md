# github-core-clone-v4

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/iamsettt1/github-core-clone-v4/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/iamsettt1/github-core-clone-v4/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, written from scratch in TypeScript on the standard library alone: git smart-HTTP protocol v2 (upload-pack / receive-pack, shallow fetch, pack deltas), the REST v3 surface (repos, contents, issues, labels, pull requests with squash merge), a hand-written GraphQL v4 executor with introspection, and an MCP server with six tools — all over one shared in-memory store. The hot paths are built for speed: whole-response fetch caching so identical clones are served one prebuilt pack, per-object deflate caching, generation-stamped fast-forward checks, and serialized-response caching for issue reads.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=9j3w1sg2&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
