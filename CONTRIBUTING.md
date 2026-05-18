# Contributing to trace-mcp

Thank you for your interest in contributing!

## Contributor License Agreement (CLA)

Before your pull request can be merged, you must sign the [Contributor License Agreement](https://cla-assistant.io/nikolai-vysotskyi/trace-mcp). This is a one-time process — CLA Assistant will prompt you automatically when you open a PR.

The full CLA text is available in [CLA.md](CLA.md). Key points:

- You **keep your copyright** — the CLA is a license grant, not an assignment.
- You grant the maintainer a broad, perpetual license to use, sublicense, and distribute your contributions under any license terms (including commercial).
- You grant a patent license for claims necessarily infringed by your contribution.
- You represent that the work is original and you have authority to contribute it.
- All contributions remain subject to the [Ethical Use Addendum](LICENSE).

## How to Contribute

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-change`)
3. Make your changes
4. Run tests (`pnpm test`)
5. Commit and push
6. Open a Pull Request

## Development

This project uses [pnpm](https://pnpm.io/) as its package manager — the version is pinned via the `packageManager` field in `package.json`. The simplest way to match it is via [Corepack](https://nodejs.org/api/corepack.html):

```bash
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install
pnpm run build
pnpm test
```

npm/yarn are not officially supported for contributor workflows — please use pnpm to ensure the lockfile and script set stay consistent.

## License

All contributions are licensed under the [MIT License](LICENSE).
