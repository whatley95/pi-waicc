# Releasing pi-waicc to npm

Publishing puts the package on the public npm registry under the maintainer's account.
A published version cannot be replaced, only deprecated, so release from `main` after CI
passes.

## One-time setup

1. Sign in at [npmjs.com](https://www.npmjs.com) (create the account if needed) and enable
   two-factor authentication.
2. Create an **Automation** access token (Account → Access Tokens → Generate New Token →
   Classic → Automation). Automation tokens publish from CI without a one-time code.
3. In GitHub: repository **Settings → Secrets and variables → Actions → New repository
   secret**, name `NPM_TOKEN`, value the token.

## Each release

1. Set the version on `main`, for example `npm version 0.2.0 --no-git-tag-version`, commit
   it with the changes it ships, and merge.
2. Tag that commit and push the tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. The **Release** workflow checks that the tag matches `package.json`, runs every test and
   the build (`prepack`), then runs `npm publish --provenance --access public`. A failing
   test publishes nothing.

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
