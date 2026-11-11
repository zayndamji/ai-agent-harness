# AI agent harness

A self-hosted web UI that runs Claude Code, the real `claude` CLI, inside a Docker container and lets you drive it from a browser. It is not made by or affiliated with Anthropic. The container sees only one folder on the host machine, the workspace folder you choose. It runs on a Mac with Docker Desktop and later on a Raspberry Pi 5.

## What it does

- Runs several Claude Code sessions at once, listed in a sidebar with what each is doing: working, waiting for your answer, or ready.
- Gives you the real Claude Code terminal in the browser: what you type, paste or click there goes to the session unchanged, as from a terminal on your own machine.
- Shows the session two ways: the real terminal, where you talk to Claude, and a read-only Chat tab with messages, tool calls and results. A run of tool calls folds into one line that opens to show each call.
- In the Chat tab: edit diffs, command output, a task list, highlighted code with Copy, long pasted messages folded to their first lines, the session's title, model, mode and context size, Claude's live status line, and a banner with the question and its choices when Claude waits for an answer in the terminal.
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
- Builds in only what the harness and Claude Code need. Extra tools come from your own `addons.conf`.

## How it works

- A Docker image holds the `claude` CLI and the server (`server/`).
- The server runs each session's `claude` in its own pseudo-terminal and streams the one a browser is looking at over a WebSocket.
- The browser draws the terminal with xterm.js. Keys typed in the terminal go back to `claude`.
- The browser's terminal sends what it would send in any terminal app (keys, pastes, mouse and focus reports, answers to Claude Code's queries), and the server writes it to `claude` as it arrives. When several browsers show one session, only the one typed into last answers the queries.
- Each session starts as plain `claude`, or `claude --resume <id>` to resume, and the server reads the new conversation's id from the record Claude Code keeps for its process.
- A copy of the screen on the server lets a browser that connects later, or reloads, see where the session is.
- The Chat tab follows the transcript Claude Code writes for the session and renders each entry as it appears.
- The live status line and dialogs are read from the server's copy of the screen.

## Repository layout

| Path | What it holds |
| --- | --- |
| `Dockerfile` | The image: Claude Code CLI, ccusage, git, ripgrep, the server, non-root user |
| `addons.example.conf` | Example add-ons: extra tools built into the image (copy to `addons.conf`) |
| `install-addons.sh` | Installs the add-ons in `addons.conf` while the image builds |
| `compose.yaml` | The `web` and `claude` services, their folders and security options |
| `server/` | The web UI: `server.js` (login, WebSocket), `slots.js` (one slot per session: its process, transcript and live status), `session.js` (the `claude` process), `transcript.js` (the Chat tab's entries), `screen.js` (live status and the input box from the screen), `files.js` (the Files and Sessions tabs' API), `usage.js` (the Usage tab's ccusage reports), `public/` (browser page; `sidebar.js` is the session list, `jobs.js` the Background panel, `usage-view.js` the Usage tab) |
| `.env.example` | Settings for the web UI: workspace folder, password, address, port, `claude` arguments |

## Run the web UI

Needs Docker (Docker Desktop on a Mac).

```bash
cp .env.example .env                       # once: then set HARNESS_PASSWORD in .env
cp addons.example.conf addons.conf         # optional: extra tools for the container, edit to taste
mkdir ~/SandboxedWorkspace                 # once: the workspace folder (HARNESS_WORKSPACE in .env)
./start.sh                                 # start Docker if needed, build, start the web UI, print its address
./start.sh --lan                           # the same, and open it to other machines on the local network
./stop.sh                                  # stop the web UI and end the session (your files are kept)
docker compose logs -f web                 # follow the server's log
```

Open the address `./start.sh` prints (http://127.0.0.1:28471 by default), log in with the password, and click Start session. On the first session, pick a theme and sign in with your Claude account: Claude Code prints a link, you open it in your browser and paste the code back. The login is kept in the workspace folder's `.claude-home`.

To work on a project, move its folder into the workspace folder, for example by dragging it in Finder. A move on the same disk is instant, even for gigabytes. Move it back when you're done. A session whose folder is moved out, renamed or removed ends the next time you type into it or open it. Claude can change or delete anything in the workspace, so keep a backup of what you can't lose.

Tools for every session go in `addons.conf`, one line per installer (`apt:`, `npm:` or `pip:`) followed by package names. The next `./start.sh` rebuilds the image with them. Tools you install from a session (`npm install -g`, `pip install --user`, programs in `~/.local/bin`) are kept in `.claude-home`.

⚠️ Docker Desktop shares all of `/Users` with its VM by default. In Docker Desktop, open Settings, Resources, File sharing, and remove everything except the workspace folder, so a container escape can't reach the rest of your files.

⚠️ `.claude-home` holds your Claude login token in a plain file. Keep the workspace folder out of cloud sync and shared folders.

Sign in with your own Claude account, and keep the web UI to yourself. Free, Pro, Max and Ultra plans fall under Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), which don't let you share an account or make it available to anyone else. Team and Enterprise plans fall under the [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), where your organization answers for everything done on its accounts, so check its rules before running the harness on a work seat. On any plan, use `--lan` only to reach the web UI from your own devices, and follow the [Usage Policy](https://www.anthropic.com/legal/aup). The harness runs the unmodified `claude` from npm, and Claude Code handles the login itself. The only input a session gets is what you type, paste or click in its terminal.

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
- ✅ Extra tools from `addons.conf`, built in by `install-addons.sh`
- ✅ Workspace folder on the host from `HARNESS_WORKSPACE`, with the home folder in its `.claude-home` (`compose.yaml`, `start.sh`)
- 🟡 Login that survives container restarts

### Single session web UI

- Done when: the browser starts a session, sends messages and shows output, behind a password.
- ✅ Server that spawns `claude` in a PTY (`server/session.js`)
- ✅ Browser page with xterm.js and a Start session button (`server/public/`)
- ✅ Password login (`server/server.js`)
- ✅ A signed-in session answering a message from the web UI
- ✅ Chat tab with messages, tool calls and results (`server/transcript.js`, `server/public/chat.js`)
- ✅ Start or resume a session in any workspace folder, and a Sessions tab across all folders (`server/public/files.js`, `server/public/sessions.js`)
- ✅ A session ends when its folder is moved out of the workspace or removed (`server/slots.js`)
- ✅ Questions shown in the Chat tab, and a Background panel for agents and background commands (`server/screen.js`, `server/public/jobs.js`)
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
