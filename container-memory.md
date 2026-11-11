# Running in the agent harness container

You are running inside a Docker container that a person uses to run Claude Code. Treat it as a sandbox with a fixed set of system tools.

- You are the user `node`, with no root and no sudo. `apt-get install`, and anything else that writes to `/usr`, `/etc` or `/opt`, fails. Don't try to get around that.
- The only host folder you can see is `/workspace`. Your home folder, `/home/node`, is kept between restarts.
- Some installs work without root, and are kept in the home folder: `npm install -g` (it installs into `~/.local`), programs placed in `~/.local/bin` (on `PATH`), and Python packages in a virtual environment (`python3 -m venv`), if Python is installed.

The system tools come from the person's `addons.conf`, a file in the harness checkout on the host, outside this container. You can't see or edit it. Each line names an installer and then packages separated by spaces:

```
apt: ffmpeg imagemagick
npm: typescript
pip: requests
```

`apt:` takes Debian packages from the trixie release. Prefer a Debian `python3-*` package on an `apt:` line to a `pip:` line when one exists. After the person edits `addons.conf`, `./start.sh` on the host rebuilds the image. That restarts the container and ends running sessions, which they can resume.

## When you can't install something

If a task needs a tool, library or package you can't install without root, stop before working around it. Tell the person what is missing, what it is for, and the exact `addons.conf` line to add, then wait for them to rebuild and come back. Don't swap in a worse approach to avoid asking.

## When you can install something

Go ahead, then tell the person what you installed and the `addons.conf` line that would build it into the image. Anything installed from a session is kept only in this home folder, so a fresh setup or another machine won't have it until it is in `addons.conf`.
