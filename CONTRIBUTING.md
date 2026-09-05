# Contributing

## Dev setup

Node 20 or newer for development (the test toolchain needs it; the shipped
bundle itself runs on Node 18.3+ and CI builds and smoke-tests it there).

```
npm install
npm test              # tsc, biome, check-skill, build, then the vitest suite
npm run smoke         # parses every real transcript on this machine
```

## Where the code lives

`src/` is the TypeScript source. `npm run build` bundles it into
`skills/promptlog/scripts/promptlog.js`, the one file every install channel
ships. That bundle is committed (plugin marketplaces and `npx skills add`
install straight from git), and CI fails when it does not match `src/`, so
**run `npm run build` and commit the bundle together with the source change
it belongs to.** Never edit the bundle by hand. Tests import `src/` directly;
tests that spawn the CLI run the bundle through `bin/promptlog.js`.

`docs/DESIGN.md` is the contract for behaviour. If code and that document
disagree, fix one of them in the same change.

## Adding an agent adapter

1. Copy the template: `cp -r src/agents/_template src/agents/<id>`.
2. Implement the `Adapter` interface from `src/agents/types.ts` in
   `src/agents/<id>/index.ts`. Every method is required; set
   `capabilities` truthfully (a `false` capability is fine, a method that
   invents data is not). A method you cannot implement honestly stays the
   template's no-op with its matching capability left `false` - core never
   guesses on an adapter's behalf.
3. Register it in `src/agents/index.ts` (one import, one list entry).
4. Add fixtures under `test/fixtures/<id>/`: a simple turn, a multi-turn
   session, and tool edits if the agent supports them.
5. `npm test`. The contract test runs against every registered adapter and
   every fixture with no test-specific changes.

## Release

1. `npm test` green.
2. `node scripts/bump-version.mjs <version>` updates `package.json`,
   `skills/promptlog/SKILL.md` (`metadata.version`), and both plugin
   manifests. Add the CHANGELOG entry.
3. `npm run build`, then commit everything: `git commit -am "Release <version>"`.
4. `git tag v<version>` and push the branch and the tag. CI runs the suite on
   ubuntu and macOS across Node 18, 20, 22, 24 and checks the committed
   bundle is fresh.
5. `npm publish --access public`. `prepublishOnly` runs `npm test` again
   before anything is uploaded.

## Design docs

- [docs/DESIGN.md](docs/DESIGN.md), the contract for current behaviour.
- [docs/PLAN-v0.3.md](docs/PLAN-v0.3.md), rationale for the v0.3/v0.4
  restructure (implemented).

Issues and PRs welcome.
