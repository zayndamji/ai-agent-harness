# Claude Code web harness

A self-hosted web UI that runs the real `claude` CLI inside a Docker container and lets you drive it from a browser. The container keeps Claude Code's files apart from the host machine. It runs on a Mac with Docker Desktop and later on a Raspberry Pi 5.

## What it does

- Starts a Claude Code session from a Start Session button in the browser.
- Sends your messages to the session and streams its output back.
- Gives the same features as the `claude` CLI: slash commands, permission prompts, auto mode and web access.
- Keeps the session's files in container volumes, never in the host's home directory.
- Puts a password in front of the web UI.

## How it works

- A Docker image holds the `claude` CLI and the server.
- The server spawns `claude` in a pseudo-terminal and passes its terminal output over a WebSocket.
- The browser draws that output with xterm.js and sends keystrokes back.
- A structured mode (`claude -p` with JSON in and out) serves chat views and messages between sessions.
- Design details and findings: `context/cli-wrapping.md`.

## Repository layout

| Path | What it holds |
| --- | --- |
| `Dockerfile` | The image: Claude Code CLI, dev tools, non-root user |
| `compose.yaml` | The container, its volumes and security options |
| `context/` | Agent memory: design notes, findings and guidelines |
| `CLAUDE.md`, `AGENTS.md` | Instructions for Claude Code and Codex sessions |

## Run Claude Code in the container

Needs Docker (Docker Desktop on a Mac).

```bash
docker compose build                       # build the image
docker compose run --rm claude             # start Claude Code in /workspace
docker compose run --rm claude bash        # open a shell in the container
docker compose build --pull --no-cache     # update Claude Code to the latest release
```

On the first start, pick a theme and sign in with your Claude account: Claude Code prints a link, you open it in your browser and paste the code back. The login is kept in the `claude-harness_home` volume.

To start in auto mode, run `docker compose run --rm claude claude --permission-mode auto`.

## Goals and progress

| Goal | Status | Next step |
| --- | --- | --- |
| Sandboxed Claude Code container | 🟡 | Sign in and check the login survives a restart |
| Single session web UI | ⬜ | Spawn `claude` in a PTY and stream it to xterm.js |
| Several sessions with message passing | ⬜ | Waits on the single session web UI |
| Always-on Raspberry Pi | ⬜ | Waits on the container |

### Sandboxed Claude Code container

- Done when: `claude` runs in the container on the Mac, logged in, with its files only in volumes.
- ✅ `Dockerfile` and `compose.yaml` with the CLI, a non-root user and volumes for the home folder and the workspace
- 🟡 Login that survives container restarts

### Single session web UI

- Done when: the browser starts a session, sends messages and shows output, behind a password.
- ⬜ Server that spawns `claude` in a PTY
- ⬜ Browser page with xterm.js and a Start Session button
- ⬜ Password login

### Several sessions with message passing

- Done when: 2 or 3 sessions run at once and can send each other messages through the server.
- ⬜ Session list in the UI
- ⬜ Message routing between sessions

### Always-on Raspberry Pi

- Done when: the same image runs on a Pi 5 and restarts on boot.
- ⬜ Image built for arm64 and amd64
- ⬜ Start on boot
