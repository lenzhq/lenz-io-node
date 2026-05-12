# Contributing

Thanks for thinking about contributing to `lenz-io` (Node SDK).

## Reporting issues

[Open an issue](https://github.com/lenzhq/lenz-io-node/issues) and include:

- SDK version (`npm ls lenz-io`)
- Node version (`node --version`)
- Minimal reproducer
- Expected vs. actual behavior
- The `X-Request-ID` from any error message (helps us trace the request)

## Setting up locally

```bash
git clone https://github.com/lenzhq/lenz-io-node
cd lenz-io-node
npm install
npm test
```

## Running tests

```bash
npm test            # all unit tests (no network)
npm run test:watch  # watch mode
npm run test:smoke  # opt-in staging smoke (needs LENZ_E2E_KEY)
```

The unit suite mocks `fetch` via vitest. Smoke tests run against `lenz.io`
(or a staging URL via `LENZ_BASE_URL`).

## Build

```bash
npm run build       # tsup → dist/index.{js,cjs,d.ts,d.cts}
npm run type        # tsc --noEmit
npm run lint        # eslint + prettier
```

## Compatibility promise

[SemVer](https://semver.org/). Breaking changes to the public surface
(anything exported from `src/index.ts`) require a major version bump.
The `X-Lenz-API-Version` header is pinned per SDK release so old SDK
clients keep working against the API version they shipped against.

## License

MIT. By contributing you agree your contribution will be licensed under
the project's MIT license.
