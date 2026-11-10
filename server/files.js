'use strict';
// The Files tab's API: list folders, preview or download files, and download
// a folder as .tar.gz, all inside the workspace folder only.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { listSessions, listAllSessions, countSessions } = require('./transcript');

const MAX_ENTRIES = 2000;
const MAX_PREVIEW = 5 * 1024 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

// File contents never run as part of the web UI: a sandboxed CSP blocks
// scripts even in an HTML file Claude wrote, and nosniff stops type guessing.
const FILE_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'same-origin',
};

class FilesApi {
  constructor(root) {
    this.root = path.resolve(root);
  }

  // Resolves a path relative to the workspace, following symlinks, and
  // refuses anything that ends up outside it.
  resolve(rel) {
    const clean = path.posix.normalize(`/${rel || ''}`).replace(/^\/+/, '');
    const rootReal = fs.realpathSync(this.root);
    const real = fs.realpathSync(path.join(this.root, clean));
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      const err = new Error('outside the workspace');
      err.status = 403;
      throw err;
    }
    return { real, rel: path.relative(rootReal, real).split(path.sep).join('/') };
  }

  list(rel) {
    const { real, rel: clean } = this.resolve(rel);
    const rootReal = fs.realpathSync(this.root);
    const items = [];
    for (const dirent of fs.readdirSync(real, { withFileTypes: true }).slice(0, MAX_ENTRIES)) {
      try {
        const full = path.join(real, dirent.name);
        // A link out of the workspace is listed, but nothing about its target is shown.
        if (dirent.isSymbolicLink()) {
          const target = fs.realpathSync(full);
          if (target !== rootReal && !target.startsWith(rootReal + path.sep)) {
            items.push({ name: dirent.name, type: 'file', link: true, outside: true, size: 0, mtime: 0 });
            continue;
          }
        }
        const stat = fs.statSync(full);
        const item = {
          name: dirent.name,
          type: stat.isDirectory() ? 'dir' : 'file',
          link: dirent.isSymbolicLink(),
          size: stat.size,
          mtime: stat.mtimeMs,
        };
        // What makes a folder a project: a git repo, a CLAUDE.md, past sessions.
        if (item.type === 'dir') {
          item.git = fs.existsSync(path.join(full, '.git'));
          item.claudeMd = fs.existsSync(path.join(full, 'CLAUDE.md'));
          item.sessions = countSessions(full);
        }
        items.push(item);
      } catch {
        items.push({ name: dirent.name, type: 'file', link: dirent.isSymbolicLink(), broken: true, size: 0, mtime: 0 });
      }
    }
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { path: clean, entries: items };
  }

  // The real folder for a workspace-relative path, for starting a session in it.
  folder(rel) {
    const { real, rel: clean } = this.resolve(rel);
    if (!fs.statSync(real).isDirectory()) {
      const err = new Error('not a folder');
      err.status = 400;
      throw err;
    }
    return { real, rel: clean };
  }

  sessions(rel) {
    const { real, rel: clean } = this.folder(rel);
    return { path: clean, sessions: listSessions(real) };
  }

  // A plain folder name: no slashes, not "." or "..", no control characters.
  mkdir(parent, name) {
    const clean = typeof name === 'string' ? name.trim() : '';
    if (!clean || clean.length > 100 || /[\/\\\x00-\x1f]/.test(clean) || clean === '.' || clean === '..') {
      const err = new Error('Use a folder name without slashes.');
      err.status = 400;
      throw err;
    }
    const { real, rel } = this.folder(parent);
    const target = path.join(real, clean);
    if (fs.existsSync(target)) {
      const err = new Error('A file or folder with that name already exists.');
      err.status = 409;
      throw err;
    }
    fs.mkdirSync(target);
    return { path: rel ? `${rel}/${clean}` : clean };
  }

  handle(req, res, pathname, query, send) {
    try {
      if (pathname === '/api/files') {
        return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(this.list(query.get('path'))));
      }
      if (pathname === '/api/sessions') {
        const body = query.get('all') === '1' ? { sessions: listAllSessions(this.root) } : this.sessions(query.get('path'));
        return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(body));
      }
      if (pathname === '/api/file') return this.file(res, query, send);
      if (pathname === '/api/archive') return this.archive(res, query, send);
    } catch (err) {
      const status = err.status || (err.code === 'ENOENT' ? 404 : err.code === 'ENOTDIR' ? 400 : 500);
      return send(res, status, { 'Content-Type': 'application/json' }, JSON.stringify({ error: err.message }));
    }
    return false;
  }

  file(res, query, send) {
    const { real } = this.resolve(query.get('path'));
    const stat = fs.statSync(real);
    if (!stat.isFile()) return send(res, 400, {}, 'Not a file');
    const name = path.basename(real);
    const download = query.get('download') === '1';
    const image = IMAGE_TYPES[path.extname(name).toLowerCase()];
    if (!download && !image && stat.size > MAX_PREVIEW) return send(res, 413, {}, 'Too large to preview');
    const headers = { ...FILE_HEADERS, 'Content-Length': stat.size };
    if (download) {
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
    } else {
      headers['Content-Type'] = image || 'text/plain; charset=utf-8';
    }
    res.writeHead(200, headers);
    fs.createReadStream(real).pipe(res);
  }

  archive(res, query, send) {
    const { real, rel } = this.resolve(query.get('path'));
    if (!fs.statSync(real).isDirectory()) return send(res, 400, {}, 'Not a folder');
    const name = rel ? path.basename(real) : 'workspace';
    res.writeHead(200, {
      ...FILE_HEADERS,
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.tar.gz`,
    });
    const tar = spawn('tar', ['-czf', '-', '-C', path.dirname(real), path.basename(real)], { stdio: ['ignore', 'pipe', 'ignore'] });
    tar.stdout.pipe(res);
    res.on('close', () => tar.kill());
  }
}

module.exports = { FilesApi };
