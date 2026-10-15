## What this changes

<!-- What and why, in a sentence or two. -->

## Checks

- [ ] `cd cli && npm run check` passes, and the rebuilt bundle, plugin binary and skill are committed
- [ ] Nothing new leaves the computer: `cli/test/privacy.test.ts` passes, and the protocol is unchanged (or bumped)
- [ ] Hooks still print nothing and exit 0
- [ ] A line under `## [Unreleased]` in `CHANGELOG.md`
- [ ] No attribution lines in commits or this description

<!-- Releases (test → main): bump the version in cli/package.json and
plugins/claude-code/.claude-plugin/plugin.json, rename Unreleased to it in the changelog, and tag
vX.Y.Z on main after merging. -->
