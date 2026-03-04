---
summary: "Install and test the Clawline fork (clickety-clacks/clawdbot) via git clone or npm, switch commits, and revert to upstream"
read_when:
  - You want to test the Clawline fork of OpenClaw
  - You want to switch between the fork and upstream
  - You want to install a specific fork commit
title: "Testing the Fork"
---

# Testing the fork

This page covers how to install and test the **Clawline fork** (`clickety-clacks/clawdbot`) of OpenClaw. The fork includes the Clawline provider (native iOS/macOS chat) and related extensions.

<Note>
Installing the fork does **not** touch your existing `~/.openclaw` config, credentials, or workspace. Your gateway configuration, auth profiles, and session history are preserved regardless of which install you're running.
</Note>

## Git clone workflow

Clone the fork, install dependencies, and build:

```bash
git clone https://github.com/clickety-clacks/clawdbot.git
cd clawdbot
pnpm install
pnpm build
```

Link the CLI globally:

```bash
pnpm link --global
```

Or run commands without linking:

```bash
pnpm openclaw gateway --port 18789 --verbose
```

### Switch to a specific fork commit

```bash
git fetch origin
git checkout <commit-sha>
pnpm install
pnpm build
```

Replace `<commit-sha>` with the commit hash you want to test.

### Revert to latest upstream release

To go back to the upstream OpenClaw release path:

```bash
npm install -g openclaw@latest
```

This replaces the fork's global CLI with the latest upstream release from npm. Run `openclaw doctor` afterward.

<Warning>
If it won't launch after switching, reinstall upstream:

```bash
npm install -g openclaw@latest && openclaw doctor
```

</Warning>

## curl / npm workflow

The [installer script](/install/installer) (`curl ... | bash`) uses **global npm install** by default. It installs from the `openclaw` npm package (upstream). To install the fork instead, use npm directly to install from the GitHub repository:

```bash
npm install -g clickety-clacks/clawdbot
```

This clones the fork, runs the build, and installs the `openclaw` CLI globally from the fork source.

### Install a specific fork commit

```bash
npm install -g clickety-clacks/clawdbot#<commit-sha>
```

Replace `<commit-sha>` with the commit you want to test.

### Revert to latest upstream release

```bash
npm install -g openclaw@latest
```

This switches back to the upstream release channel. Run `openclaw doctor` afterward.

<Warning>
If it won't launch after switching, reinstall upstream:

```bash
npm install -g openclaw@latest && openclaw doctor
```

</Warning>

## Homebrew

Homebrew install support will be added in a future update.

## Notes

- Both workflows preserve your `~/.openclaw` directory (config, credentials, workspace, sessions).
- The fork tracks upstream `openclaw/openclaw` and periodically rebases. It may include commits not yet in upstream.
- To verify which version you're running: `openclaw --version` and check whether the binary resolves to the fork checkout or the npm global.
