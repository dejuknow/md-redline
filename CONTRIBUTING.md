# Contributing

Thanks for helping improve `md-review`.

## Development setup

```bash
npm install
npm run dev
```

The app starts:

- Hono on `http://localhost:3001`
- Vite on `http://localhost:5173`

## Before opening a PR

Please run the same checks we expect in CI:

```bash
npm run lint
npm test
npm run eval:dry
npm run test:e2e
```

## Scope and style

- Keep the app local-first. Comments live in the markdown file itself.
- Preserve the current workflow: comments are agent instructions by default, with the optional resolve workflow for human review.
- Add tests for behavior changes whenever practical.
- Prefer small, focused pull requests with clear commit messages.

## Reporting bugs

When filing an issue, include:

- your OS and Node version
- how you opened the file (`md-review`, URL param, or file browser)
- whether the problem happens in rendered, raw, or diff view
- a minimal markdown example if the issue is selection, highlighting, or parsing related

## Security

Please do not open public issues for security-sensitive problems. See [SECURITY.md](./SECURITY.md).
