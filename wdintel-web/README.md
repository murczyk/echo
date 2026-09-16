# my new project

> 🌳 built with [elm-spa](https://elm-spa.dev)

## dependencies

This project requires the latest LTS version of [Node.js](https://nodejs.org/)

Private `@echoua/*` packages are installed from GitHub Packages. `.npmrc` in this directory points the registry at `npm.pkg.github.com`; export a personal access token before install:

```bash
export GITHUB_TOKEN=ghp_...   # read:packages (+ repo if needed)
npm ci
```

```bash
npm install -g elm elm-spa
```

## running locally

```bash
elm-spa server  # starts this app at http:/localhost:1234
```

### other commands

```bash
elm-spa add    # add a new page to the application
elm-spa build  # production build
elm-spa watch  # runs build as you code (without the server)
```

## testing

```bash
npm run test:ts                 # complete React Vitest migration suite
npm run test:ts:scope-check     # admission validation only
```

Default React tests must carry a co-located `@test-scope` annotation for
operational parser coverage, a concrete safeguard, or an Echo-linked
regression. Unclassified tests fail the scope check immediately. Newly
introduced test-only production exports also fail relative to the PR merge
base; inherited exports are informational.

Browser commands are intentionally separate:

```bash
npm run e2e:smoke
npm run e2e:regression
npm run e2e:all
```

Do not replace Vitest coverage with browser coverage until the blocking
Playwright workflow is enabled and stable.

## learn more

You can learn more at [elm-spa.dev](https://elm-spa.dev)
