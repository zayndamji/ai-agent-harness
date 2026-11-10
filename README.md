# Claude Code web harness

A self-hosted web UI that runs the real `claude` CLI inside a Docker container and lets you drive it from a browser. The container keeps Claude Code's files apart from the host machine. It runs on a Mac with Docker Desktop and later on a Raspberry Pi 5.

## What it does

- Runs several Claude Code sessions at once, listed in a sidebar with what each is doing: working, waiting for your answer, or ready.
- Sends your keystrokes and messages to the session and streams its output back.
- Types what you write in the message box into Claude Code as you type it, key by key, like a person at the terminal, and pastes it on Send when it can't be typed exactly.
- Shows the session two ways: the real terminal, and a Chat tab with messages, tool calls and results one by one.
- In the Chat tab: edit diffs, command output, a task list, highlighted code with Copy, the session's title, model, mode and context size, Claude's live status line, prompt suggestions, and a banner when Claude waits for an answer.
- Lets you answer Claude's questions and prompts from the Chat tab, including typing your own answer.
- Shows agents and background commands as they run: their steps, reports and live output, in cards and in a Background panel beside the chat.
- Notifies you when Claude finishes or needs an answer while the tab is in the background.
- Has a Files tab to browse the workspace, preview text and images, and download a file or a whole folder.
- Starts a session in any workspace folder, new or resuming an earlier conversation, from the Files tab, and makes new folders. Several sessions can share a folder.
- Has a Sessions tab listing every conversation, one line each, in a section per project folder, with search.
- Has a Usage tab: tokens and estimated cost per day, the current 5-hour block, breakdowns by project, token type and model, and every session, day and block in detail, from [ccusage](https://github.com/ccusage/ccusage) running offline.
- Gives the same features as the `claude` CLI: slash commands, permission prompts, auto mode and web access.
- Keeps sessions running when the browser closes, and shows the current screen when you come back. Each browser tab can show a different session.
- Keeps the session's files in container volumes, never in the host's home directory.
- Puts a password in front of the web UI.

## How it works

- A Docker image holds the `claude` CLI and the server (`server/`).
- The server runs each session's `claude` in its own pseudo-terminal and streams the one a browser is looking at over a WebSocket.
- The browser draws the terminal with xterm.js. Keys typed in the terminal go back to `claude`.
- Each change in the message box goes to the server, which presses the same keys in Claude Code's input box (characters, Backspace, arrow keys) and checks the box on screen afterwards. Send presses Enter.
- A copy of the screen on the server lets a browser that connects later, or reloads, see where the session is.
- The Chat tab follows the transcript Claude Code writes for the session and renders each entry as it appears. Messages sent from it go into the same terminal.
- The live status line, suggestions and dialogs are read from the server's copy of the screen.

## Repository layout

| Path | What it holds |
| --- | --- |
| `Dockerfile` | The image: Claude Code CLI, ccusage, dev tools, the server, non-root user |
| `compose.yaml` | The `web` and `claude` services, their volumes and security options |
| `server/` | The web UI: `server.js` (login, WebSocket), `slots.js` (one slot per session: its process, transcript, typist and live status), `session.js` (the `claude` process), `transcript.js` (the Chat tab's entries), `screen.js` (live status and the input box from the screen), `typist.js` (types the message box into Claude Code), `files.js` (the Files and Sessions tabs' API), `usage.js` (the Usage tab's ccusage reports), `public/` (browser page; `sidebar.js` is the session list, `jobs.js` the Background panel, `usage-view.js` the Usage tab) |
| `.env.example` | Settings for the web UI: password, address, port, `claude` arguments |

## Run the web UI

Needs Docker (Docker Desktop on a Mac).

```bash
cp .env.example .env                       # once: then set HARNESS_PASSWORD in .env
./start.sh                                 # start Docker if needed, build, start the web UI, print its address
./stop.sh                                  # stop the web UI and end the session (volumes are kept)
docker compose logs -f web                 # follow the server's log
```

Open the address `./start.sh` prints (http://127.0.0.1:8080 by default), log in with the password, and click Start session. On the first session, pick a theme and sign in with your Claude account: Claude Code prints a link, you open it in your browser and paste the code back. The login is kept in the `claude-harness_home` volume.

The web UI listens only on this computer. To reach it from other machines on your network, set `HARNESS_BIND=0.0.0.0` in `.env`. To start sessions in auto mode, set `HARNESS_CLAUDE_ARGS=--permission-mode auto`. Up to 10 sessions run at once; set `HARNESS_MAX_SESSIONS` for a different limit.

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
| Several sessions with message passing | 🟡 | Message routing between sessions |
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
- ✅ Start or resume a session in any workspace folder, and a Sessions tab across all folders (`server/public/files.js`, `server/public/sessions.js`)
- ✅ Answer questions from the Chat tab, and a Background panel for agents and background commands (`server/screen.js`, `server/public/jobs.js`)
- ✅ Usage tab from ccusage, offline (`server/usage.js`, `server/public/usage-view.js`)

### Several sessions with message passing

- Done when: 2 or 3 sessions run at once and can send each other messages through the server.
- ✅ Each session in its own slot on the server, with WebSocket messages per slot (`server/slots.js`)
- ✅ Several sessions at once with a session list in the UI (`server/public/sidebar.js`)
- ⬜ Message routing between sessions

### Always-on Raspberry Pi

- Done when: the same image runs on a Pi 5 and restarts on boot.
- ⬜ Image built for arm64 and amd64
- ⬜ Start on boot
