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
| `context/` | Agent memory: design notes, findings and guidelines |
| `CLAUDE.md`, `AGENTS.md` | Instructions for Claude Code and Codex sessions |

## Goals and progress

| Goal | Status | Next step |
| --- | --- | --- |
| Sandboxed Claude Code container | ⬜ | Write the Dockerfile and compose file |
| Single session web UI | ⬜ | Spawn `claude` in a PTY and stream it to xterm.js |
| Several sessions with message passing | ⬜ | Waits on the single session web UI |
| Always-on Raspberry Pi | ⬜ | Waits on the container |

### Sandboxed Claude Code container

- Done when: `claude` runs in the container on the Mac, logged in, with its files only in volumes.
- ⬜ Dockerfile with the CLI, a non-root user and volumes for `~/.claude` and the workspace
- ⬜ Login that survives container restarts

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
