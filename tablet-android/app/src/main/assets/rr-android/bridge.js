// Ricochet Rumble on an Android tablet — gives the game page the same
// window.rrApp the Windows app has (Settings > Check for updates, Update now,
// Full screen, Quit). The tablet app's web server adds this script to the
// game page; window.RRAndroid is the app's Java/Kotlin side.
(function () {
  const A = window.RRAndroid;
  if (!A) return; // opened in an ordinary browser: nothing to do

  const REPO = 'trout1758-cpu/Ricochet-Rumble';
  const pending = {};
  let seq = 0;
  let onProgress = null;

  // The app answers long jobs (downloads) by calling back into the page.
  window.__rrAndroid = {
    done(id, json) {
      const fn = pending[id];
      delete pending[id];
      if (fn) fn(JSON.parse(json));
    },
    progress(json) {
      if (onProgress) onProgress(JSON.parse(json));
    },
  };
  const call = (method, ...args) => new Promise((resolve) => {
    const id = String(++seq);
    pending[id] = resolve;
    A[method](id, ...args);
  });

  // dates come as "...Z" from GitHub and "...+00:00" from git: compare them as times
  const when = (iso) => Date.parse(iso || '') || 0;

  async function github(path) {
    const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(res.status === 403 ? 'GitHub is busy (too many checks). Try again in a little while.' : `GitHub answered ${res.status}`);
    return res.json();
  }

  async function checkForUpdates() {
    try {
      const info = JSON.parse(A.info());
      const commits = await github('/commits?sha=main&path=game&per_page=1');
      if (!Array.isArray(commits) || !commits.length) throw new Error('no game versions found');
      const c = commits[0];
      const latest = { sha: c.sha, date: c.commit.committer.date, message: String(c.commit.message || '').split('\n')[0] };
      const available = latest.sha !== info.game.sha && when(latest.date) > when(info.game.date);
      // a newer build of the tablet app itself?
      let app = null;
      try {
        const rel = await github('/releases/tags/tablet-latest');
        const m = /build (\d+)/i.exec(rel.name || '');
        if (m && Number(m[1]) > info.build) app = { version: `build ${m[1]}`, url: rel.html_url };
      } catch (e) { /* no tablet release yet */ }
      return { ok: true, current: info.game, latest, available, app };
    } catch (e) {
      const msg = String((e && e.message) || e);
      return { ok: false, error: /fetch|network|Failed/i.test(msg) ? 'No internet connection. Connect to the internet to check for updates.' : msg };
    }
  }

  window.rrApp = {
    platform: 'android',
    info: async () => JSON.parse(A.info()),
    checkForUpdates,
    installUpdate: (latest) => call('install', latest.sha, latest.date, latest.message || ''),
    resetGame: () => call('reset'),
    reload: async () => A.reload(),
    toggleFullscreen: async () => A.toggleFullscreen(),
    openLink: async (url) => A.openLink(url),
    quit: async () => A.quit(),
    onProgress: (fn) => { onProgress = fn; },
  };
})();
