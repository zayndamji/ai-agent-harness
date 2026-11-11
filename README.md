# Claude Code web harness

A self-hosted web UI that runs the real `claude` CLI inside a Docker container and lets you drive it from a browser. The container sees only one folder on the host machine, the workspace folder you choose. It runs on a Mac with Docker Desktop and later on a Raspberry Pi 5.

## What it does

- Runs several Claude Code sessions at once, listed in a sidebar with what each is doing: working, waiting for your answer, or ready.
- Sends your keystrokes and messages to the session and streams its output back.
- Types what you write in the message box into Claude Code as you type it, key by key, like a person at the terminal, and pastes it on Send when it can't be typed exactly.
- Shows the session two ways: the real terminal, and a Chat tab with messages, tool calls and results one by one.
- In the Chat tab: edit diffs, command output, a task list, highlighted code with Copy, the session's title, model, mode and context size, Claude's live status line, prompt suggestions, and a banner when Claude waits for an answer.
- Lets you answer Claude's questions and prompts from the Chat tab, including typing your own answer.
- Shows agents and background commands as they run: their steps, reports and live output, in cards and in a Background panel beside the chat.
- Notifies you when Claude finishes or needs an answer in any session while the tab is in the background.
- Shows messages sessions send each other with Claude Code's own SendMessage, as cards in the Chat tab that link to the other session.
- Has a Files tab to browse the workspace, preview text and images, and download a file or a whole folder.
- Starts a session in any workspace folder, new or resuming an earlier conversation, from the Files tab, and makes new folders. Several sessions can share a folder.
- Has a Sessions tab listing every conversation, one line each, in a section per project folder, with search.
- Has a Usage tab: tokens and estimated cost per day, the current 5-hour block, breakdowns by project, token type and model, and every session, day and block in detail, from [ccusage](https://github.com/ccusage/ccusage) running offline.
- Gives the same features as the `claude` CLI: slash commands, permission prompts, auto mode and web access.
- Keeps sessions running when the browser closes, and shows the current screen when you come back. Each browser tab can show a different session.
- Works in one folder on the host that you choose (`HARNESS_WORKSPACE`, `~/SandboxedWorkspace` by default). Move a project into it to work on it, and move it back out when you're done. Claude Code's login and history are kept in its `.claude-home` folder, which sessions don't see in `/workspace`.
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
| `compose.yaml` | The `web` and `claude` services, their folders and security options |
| `server/` | The web UI: `server.js` (login, WebSocket), `slots.js` (one slot per session: its process, transcript, typist and live status), `session.js` (the `claude` process), `transcript.js` (the Chat tab's entries), `screen.js` (live status and the input box from the screen), `typist.js` (types the message box into Claude Code), `files.js` (the Files and Sessions tabs' API), `usage.js` (the Usage tab's ccusage reports), `public/` (browser page; `sidebar.js` is the session list, `jobs.js` the Background panel, `usage-view.js` the Usage tab) |
| `.env.example` | Settings for the web UI: workspace folder, password, address, port, `claude` arguments |

## Run the web UI

Needs Docker (Docker Desktop on a Mac).

```bash
cp .env.example .env                       # once: then set HARNESS_PASSWORD in .env
mkdir ~/SandboxedWorkspace                 # once: the workspace folder (HARNESS_WORKSPACE in .env)
./start.sh                                 # start Docker if needed, build, start the web UI, print its address
./start.sh --lan                           # the same, and open it to other machines on the local network
./stop.sh                                  # stop the web UI and end the session (your files are kept)
docker compose logs -f web                 # follow the server's log
```

Open the address `./start.sh` prints (http://127.0.0.1:28471 by default), log in with the password, and click Start session. On the first session, pick a theme and sign in with your Claude account: Claude Code prints a link, you open it in your browser and paste the code back. The login is kept in the workspace folder's `.claude-home`.

To work on a project, move its folder into the workspace folder, for example by dragging it in Finder. A move on the same disk is instant, even for gigabytes. Move it back when you're done. Claude can change or delete anything in the workspace, so keep a backup of what you can't lose.

⚠️ Docker Desktop shares all of `/Users` with its VM by default. In Docker Desktop, open Settings, Resources, File sharing, and remove everything except the workspace folder, so a container escape can't reach the rest of your files.

⚠️ `.claude-home` holds your Claude login token in a plain file. Keep the workspace folder out of cloud sync and shared folders.

Only this computer can open the web UI, unless you start it with `./start.sh --lan`. To start sessions in auto mode, set `HARNESS_CLAUDE_ARGS=--permission-mode auto`. Up to 10 sessions run at once; set `HARNESS_MAX_SESSIONS` for a different limit.

## Run Claude Code in your terminal

The `claude` service uses the same image and folders, without the web UI.

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
| Several sessions with message passing | ✅ | |
| Always-on Raspberry Pi | ⬜ | Image built for arm64 and amd64 |

### Sandboxed Claude Code container

- Done when: `claude` runs in the container on the Mac, logged in, seeing only the workspace folder.
- ✅ `Dockerfile` and `compose.yaml` with the CLI and a non-root user
- ✅ Workspace folder on the host from `HARNESS_WORKSPACE`, with the home folder in its `.claude-home` (`compose.yaml`, `start.sh`)
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

- Done when: 2 or 3 sessions run at once and message each other through Claude Code's SendMessage, shown in the web UI.
- ✅ Each session in its own slot on the server, with WebSocket messages per slot (`server/slots.js`)
- ✅ Several sessions at once with a session list in the UI (`server/public/sidebar.js`)
- ✅ Sessions sharing a folder keep their own chat through `/clear` and `/resume`, and every session notifies (`server/server.js`)
- ✅ Sessions message each other with Claude Code's SendMessage, shown in the Chat tab (`server/transcript.js`, `server/public/chat.js`)

### Always-on Raspberry Pi

- Done when: the same image runs on a Pi 5 and restarts on boot.
- ⬜ Image built for arm64 and amd64
- ⬜ Start on boot
