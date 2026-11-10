'use strict';
// The Usage tab's data: ccusage's daily, per-project, per-session and 5-hour
// block reports for Claude Code, run in the viewer's timezone. Always with
// --offline: ccusage then uses the prices built into it and never goes online.

const { execFile } = require('node:child_process');
const { listAllSessions } = require('./transcript');

const CACHE_MS = 60_000;
const TIMEOUT_MS = 120_000;
const TZ = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

function ccusage(args, env) {
  return new Promise((resolve, reject) => {
    execFile('ccusage', ['claude', ...args, '--json', '--offline', '--no-color'], { env, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split('\n').pop()));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('ccusage did not return JSON'));
      }
    });
  });
}

let version = null;
function ccusageVersion(env) {
  if (version) return Promise.resolve(version);
  return new Promise((resolve) => {
    execFile('ccusage', ['--version'], { env, timeout: 10_000 }, (err, stdout) => {
      version = err ? 'unknown' : stdout.trim().replace(/^ccusage\s*/, '');
      resolve(version);
    });
  });
}

class UsageReports {
  constructor({ root, env }) {
    this.root = root;
    // Only what ccusage needs: where the transcripts are, and a quiet terminal.
    this.env = { PATH: env.PATH, HOME: env.HOME, NO_COLOR: '1', ...(env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : {}) };
    this.cache = new Map();
  }

  // { generatedAt, timezone, version, daily, projects, sessions, blocks }
  async get(timezone, { refresh = false } = {}) {
    const tz = TZ.test(timezone || '') ? timezone : 'UTC';
    const hit = this.cache.get(tz);
    if (hit && !refresh && Date.now() - hit.at < CACHE_MS) return hit.promise;
    const promise = this.build(tz);
    this.cache.set(tz, { at: Date.now(), promise });
    promise.catch(() => this.cache.delete(tz));
    return promise;
  }

  async build(tz) {
    const zone = ['-z', tz];
    const [daily, perProject, sessions, blocks, v] = await Promise.all([
      ccusage(['daily', '--breakdown', ...zone], this.env),
      ccusage(['daily', '--instances', ...zone], this.env),
      ccusage(['session', '--breakdown', ...zone], this.env),
      ccusage(['blocks', '--breakdown', ...zone], this.env),
      ccusageVersion(this.env),
    ]);

    // Session titles and real folders from the transcripts. ccusage names a
    // project by its folder name with every non-alphanumeric as a dash, which
    // can't be turned back into a path; a session's own `cwd` can.
    const known = new Map(listAllSessions(this.root, 5000).map((s) => [s.id, s]));
    const folderOf = new Map();
    for (const s of sessions.sessions || []) {
      const k = known.get(s.sessionId);
      if (k) folderOf.set(s.projectPath, k.folder);
    }
    const label = (projectPath) => {
      if (folderOf.has(projectPath)) {
        const f = folderOf.get(projectPath);
        return f ? `workspace/${f}` : 'workspace';
      }
      return projectPath;
    };

    return {
      generatedAt: new Date().toISOString(),
      timezone: tz,
      version: v,
      daily: daily.daily || [],
      totals: daily.totals || null,
      projects: Object.entries(perProject.projects || {}).map(([projectPath, days]) => ({
        project: label(projectPath),
        folder: folderOf.has(projectPath) ? folderOf.get(projectPath) : null,
        days: days.map(({ date, totalTokens, totalCost, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens }) => ({ date, totalTokens, totalCost, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens })),
      })),
      sessions: (sessions.sessions || []).map((s) => {
        const k = known.get(s.sessionId);
        return { ...s, title: k?.title || k?.lastPrompt || null, folder: k ? k.folder : null, project: label(s.projectPath) };
      }),
      blocks: (blocks.blocks || []).filter((b) => !b.isGap),
    };
  }
}

module.exports = { UsageReports };
