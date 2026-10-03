# Contributing to MotionForge

Thanks for your interest! Bug reports, presets and code are all welcome.

## Setup

```bash
git clone https://github.com/<your-username>/motionforge.git
cd motionforge
npm install
npm run dev
```

Node.js 20.11+ is required (22 LTS recommended).

## Before opening a pull request

```bash
npm run typecheck
npm test
```

Both must pass. CI runs them on Linux, macOS and Windows.

## Guidelines

- **One topic per pull request**, with a short description of the change and how you checked it. For visual changes, add a preview frame or contact sheet.
- **Keep the DSL declarative**: presets are JSON and never execute code. New behaviour goes into a feature module under `src/dsl/features/` (compiler side) and `src/remotion/` (player side).
- **Document new DSL keys** in `src/mcp/reference.ts` (the reference agents read) and, if user-facing, in `README.md` or `AGENTS.md`.
- **`@core` libraries**: published versions are immutable. Change a library in its `draft/` folder (or through `mf_preset_put`), then publish a new semver version. Every preset needs a realistic `example`, because that is how it is tested.
- **Don't commit generated data**: `data/`, renders, agent libraries (`libraries/@<agent>/`) and `motionforge.config.json` are ignored on purpose.
- **Code style**: TypeScript strict and ESM. Prefer small, explicit functions, and keep comments for the *why*.

## Reporting bugs

Open an issue with:

- your OS and Node version;
- the composition JSON, or the smallest one that reproduces the bug;
- the error message, or the `mf_preview` frame showing the problem.
