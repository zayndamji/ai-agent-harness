# Claude Code web harness

A self-hosted web UI that runs the real `claude` CLI inside a Docker container and lets you drive it from a browser. The container keeps Claude Code's files apart from the host machine. It runs on a Mac with Docker Desktop and later on a Raspberry Pi 5.

## What it does

- Starts a Claude Code session from a Start session button in the browser.
- Sends your keystrokes and messages to the session and streams its output back.
- Shows the session two ways: the real terminal, and a Chat tab with messages, tool calls and results one by one.
- Gives the same features as the `claude` CLI: slash commands, permission prompts, auto mode and web access.
- Keeps the session running when the browser closes, and shows the current screen when you come back.
- Keeps the session's files in container volumes, never in the host's home directory.
- Puts a password in front of the web UI.

## How it works

- A Docker image holds the `claude` CLI and the server (`server/`).
- The server runs `claude` in a pseudo-terminal and streams its output to the browser over a WebSocket.
- The browser draws the terminal with xterm.js. Keys typed in the terminal and text from the message box go back to `claude`.
- A copy of the screen on the server lets a browser that connects later, or reloads, see where the session is.
- The Chat tab follows the transcript Claude Code writes for the session and renders each entry as it appears. Messages sent from it go into the same terminal.
- Design details and findings: `context/cli-wrapping.md`, `context/web-ui.md` and `context/chat-view.md`.

## Repository layout

| Path | What it holds |
| --- | --- |
| `Dockerfile` | The image: Claude Code CLI, dev tools, the server, non-root user |
| `compose.yaml` | The `web` and `claude` services, their volumes and security options |
| `server/` | The web UI: `server.js` (login, WebSocket), `session.js` (the `claude` process), `transcript.js` (the Chat tab's entries), `public/` (browser page) |
| `.env.example` | Settings for the web UI: password, address, port, `claude` arguments |
| `context/` | Agent memory: design notes, findings and guidelines |
| `CLAUDE.md`, `AGENTS.md` | Instructions for Claude Code and Codex sessions |

## Run the web UI

Needs Docker (Docker Desktop on a Mac).

```bash
cp .env.example .env                       # then set HARNESS_PASSWORD in .env
docker compose up -d --build web           # build the image and start the web UI
docker compose logs -f web                 # follow the server's log
docker compose down                        # stop it (volumes are kept)
```

Open http://127.0.0.1:8080, log in with the password, and click Start session. On the first session, pick a theme and sign in with your Claude account: Claude Code prints a link, you open it in your browser and paste the code back. The login is kept in the `claude-harness_home` volume.

The web UI listens only on this computer. To reach it from other machines on your network, set `HARNESS_BIND=0.0.0.0` in `.env`. To start sessions in auto mode, set `HARNESS_CLAUDE_ARGS=--permission-mode auto`.

## Run Claude Code in your terminal

The `claude` service uses the same image and volumes, without the web UI.

```bash
docker compose run --rm claude             # start Claude Code in /workspace
docker compose run --rm claude bash        # open a shell in the container
docker compose build --pull --no-cache     # update Claude Code to the latest release
```

## Goals and progress

| Goal | Status | Next step |
| --- | --- | --- |
| Sandboxed Claude Code container | 🟡 | Sign in and check the login survives a restart |
| Single session web UI | ✅ | |
| Several sessions with message passing | ⬜ | Session list in the UI |
| Always-on Raspberry Pi | ⬜ | Image built for arm64 and amd64 |

### Sandboxed Claude Code container

- Done when: `claude` runs in the container on the Mac, logged in, with its files only in volumes.
- ✅ `Dockerfile` and `compose.yaml` with the CLI, a non-root user and volumes for the home folder and the workspace
- 🟡 Login that survives container restarts

### Single session web UI

- Done when: the browser starts a session, sends messages and shows output, behind a password.
- ✅ Server that spawns `claude` in a PTY (`server/session.js`)
- ✅ Browser page with xterm.js, a Start session button and a message box (`server/public/`)
- ✅ Password login (`server/server.js`)
- ✅ A signed-in session answering a message from the web UI
- ✅ Chat tab with messages, tool calls and results (`server/transcript.js`, `server/public/chat.js`)

### Several sessions with message passing

- Done when: 2 or 3 sessions run at once and can send each other messages through the server.
- ⬜ Session list in the UI
- ⬜ Message routing between sessions

### Always-on Raspberry Pi

- Done when: the same image runs on a Pi 5 and restarts on boot.
- ⬜ Image built for arm64 and amd64
- ⬜ Start on boot
