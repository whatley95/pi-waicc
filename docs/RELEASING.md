# Releasing pi-waicc to npm

Publishing puts the package on the public npm registry under the maintainer's account.
A published version cannot be replaced, only deprecated, so release from `main` after CI
passes.

## One-time setup

The Release workflow publishes with npm [trusted publishing](https://docs.npmjs.com/trusted-publishers):
npm checks that the upload comes from this repository's workflow, so no npm token is stored
in GitHub. A trusted publisher is set in the package's settings, so the package has to exist
first, and the first version is published by hand.

1. Sign in at [npmjs.com](https://www.npmjs.com) (create the account if needed) and enable
   two-factor authentication.
2. Publish the first version from a clean checkout of `main` (see
   [Publishing by hand](#publishing-by-hand)), then tag that commit, for example
   `git tag v0.1.0 && git push origin v0.1.0`. The workflow then fails at `npm publish`,
   because the version is already on npm; nothing else happens.
3. On npmjs.com, open the package → **Settings → Trusted publishing → GitHub Actions**, and
   enter the owner `whatley95`, the repository `pi-waicc` and the workflow file `release.yml`
   (no environment). The fields are case-sensitive.
4. Under **Publishing access**, choose **Require two-factor authentication and disallow
   tokens**: from then on only this workflow, or you with a one-time code, can publish.

npm no longer issues classic or automation tokens. Granular tokens that can publish expire,
so a stored token would keep breaking releases; trusted publishing has nothing to renew.

## Each release

1. Set the version on `main`, for example `npm version 0.2.0 --no-git-tag-version`, commit
   it with the changes it ships, and merge.
2. Tag that commit and push the tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. The **Release** workflow checks that the tag matches `package.json`, runs every test and
   the build (`prepack`), then runs `npm publish --access public` through trusted
   publishing, which also attaches provenance (the package links back to the workflow run).
   A failing test publishes nothing.

## After the first release

Once `npm view pi-waicc` shows the version, these work and can lead the README:

```sh
npm install -g pi-waicc                            # puts the waicc command on PATH
pi install npm:pi-waicc                            # Pi's own copy, from npm
claude mcp add --scope user waicc -- waicc mcp     # register the MCP server with the short command
```

Check on Windows, macOS and Linux that `waicc --help` runs after the global install, then
change the README's install and MCP sections to lead with these commands.

## Publishing by hand

From a clean checkout of the tagged commit: `npm login`, then `npm publish --access public`.
`prepack` runs the same checks and build first.
