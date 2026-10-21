/* Visual page editor. Loads the real page, lets you type on it, and saves the HTML back to GitHub.
   Netlify then publishes the change. No server, no build step. */
(() => {
  const C = window.ADMIN_CONFIG;
  const $ = (id) => document.getElementById(id);
  const API = 'https://api.github.com';
  const LOCAL = location.hostname === 'localhost' && /[?&]local=1/.test(location.search); // test mode: no GitHub

  let token = '';
  let page = null;        // { path, sha }
  let dirty = false;
  let pending = new Map(); // repo path -> Blob (pictures waiting to be published)
  let idoc = null;
  let selImg = null;
  let selLink = null;

  /* ---------- small helpers ---------- */
  const store = {
    get() { try { return localStorage.getItem('editorToken:' + C.repo) || ''; } catch (e) { return ''; } },
    set(v) { try { v ? localStorage.setItem('editorToken:' + C.repo, v) : localStorage.removeItem('editorToken:' + C.repo); } catch (e) {} }
  };
  const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
  const utf8ToB64 = (s) => {
    const b = new TextEncoder().encode(s); let bin = '';
    for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const b64ToUtf8 = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
  const blobToB64 = (blob) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
  const status = (msg, cls) => { const s = $('status'); s.textContent = msg || ''; s.className = cls || ''; };
  const show = (id, on) => $(id).classList.toggle('hide', !on);

  async function gh(path, opts = {}) {
    const r = await fetch(API + path, Object.assign({}, opts, {
      headers: Object.assign({
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }, opts.body ? { 'Content-Type': 'application/json' } : {})
    }));
    if (!r.ok) {
      const e = new Error((await r.json().catch(() => ({}))).message || r.statusText);
      e.status = r.status; throw e;
    }
    return r.status === 204 ? null : r.json();
  }

  /* ---------- sign in ---------- */
  async function signIn(t) {
    token = t;
    const repo = await gh('/repos/' + C.repo);
    if (!repo.permissions || !repo.permissions.push) throw new Error('This token can read the site but is not allowed to change it. Give it "Contents: Read and write".');
    store.set(t);
  }
  $('loginBtn').onclick = async () => {
    const t = $('tok').value.trim();
    $('loginErr').textContent = '';
    if (!t) { $('loginErr').textContent = 'Paste your token first.'; return; }
    try { await signIn(t); await start(); }
    catch (e) { token = ''; $('loginErr').textContent = e.status === 401 || e.status === 404 ? 'GitHub did not accept that token for this site. Check it was made for the right repository.' : e.message; }
  };
  $('logoutBtn').onclick = () => {
    if (dirty && !confirm('You have unpublished changes. Sign out anyway?')) return;
    store.set(''); location.reload();
  };

  /* ---------- pages ---------- */
  let allPages = [];
  const liveUrl = (path) => {
    let p = path.slice(C.publishDir.length);
    if (p === 'index.html') return '/';
    if (p.endsWith('/index.html')) return '/' + p.slice(0, -10);
    return '/' + p;
  };
  async function listPages() {
    if (LOCAL) return (C.localPages || ['index.html']).map((p) => C.publishDir + p);
    const t = await gh('/repos/' + C.repo + '/git/trees/' + encodeURIComponent(C.branch) + '?recursive=1');
    return t.tree.filter((x) => x.type === 'blob' && x.path.endsWith('.html') && x.path.startsWith(C.publishDir) && !/(^|\/)admin\//.test(x.path)).map((x) => x.path);
  }
  function renderPages() {
    const q = $('pageFilter').value.trim().toLowerCase();
    const box = $('pageList'); box.textContent = '';
    allPages.filter((p) => !q || p.toLowerCase().includes(q)).forEach((p) => {
      const b = document.createElement('button');
      const u = liveUrl(p);
      b.textContent = u === '/' ? 'Home page' : u;
      const s = document.createElement('small'); s.textContent = p; b.appendChild(s);
      b.onclick = () => { show('pages', false); openPage(p); };
      box.appendChild(b);
    });
    if (!box.firstChild) box.textContent = 'No pages match.';
  }
  $('pagesBtn').onclick = () => { show('pages', true); $('pageFilter').value = ''; renderPages(); $('pageFilter').focus(); };
  $('pagesClose').onclick = () => show('pages', false);
  $('pageFilter').oninput = renderPages;

  async function openPage(path) {
    if (dirty && !confirm('You have unpublished changes on this page. Leave without publishing?')) return;
    status('Loading page...');
    try {
      let html, sha = '';
      if (LOCAL) {
        html = await (await fetch('/' + path.slice(C.publishDir.length))).text();
      } else {
        const f = await gh('/repos/' + C.repo + '/contents/' + encPath(path) + '?ref=' + encodeURIComponent(C.branch));
        sha = f.sha;
        html = b64ToUtf8((await gh('/repos/' + C.repo + '/git/blobs/' + f.sha)).content);
      }
      page = { path, sha };
      pending = new Map();
      loadFrame(html);
    } catch (e) { status('Could not load the page: ' + e.message, 'bad'); }
  }

  /* ---------- the editing surface ---------- */
  const EDIT_CSS = `
    .cur{display:none!important}
    .rv{opacity:1!important;transform:none!important}
    .hero .h1like .l>span{transform:none!important;animation:none!important}
    .row .more{grid-template-rows:1fr!important;visibility:visible!important}
    .more>div{overflow:visible!important}
    [contenteditable]{outline:1px dashed transparent;outline-offset:2px;cursor:text}
    [contenteditable]:hover{outline-color:#1a5fd0}
    [contenteditable]:focus{outline:2px solid #1a5fd0}
    img,figure[data-img]{cursor:pointer}
    img:hover{outline:3px solid #1a5fd0;outline-offset:-3px}
    .ed-selected{outline:3px solid #1a5fd0!important;outline-offset:-3px}
    a{cursor:text}
  `;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION', 'SELECT', 'TEXTAREA', 'TITLE', 'HEAD', 'HTML', 'BODY', 'TEMPLATE', 'IFRAME', 'OPTGROUP']);
  const INLINE = new Set(['A', 'EM', 'B', 'I', 'STRONG', 'SPAN', 'SMALL', 'U', 'MARK', 'SUP', 'SUB', 'CODE']);

  function loadFrame(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script').forEach((s) => {
      s.setAttribute('data-ed-had-type', s.hasAttribute('type') ? '1' : '0');
      s.setAttribute('data-ed-type', s.getAttribute('type') || '');
      s.setAttribute('type', 'text/plain'); // keeps the script in the file but stops it running while editing
    });
    const base = doc.createElement('base'); base.setAttribute('data-ed', ''); base.href = location.origin + liveUrl(page.path);
    const st = doc.createElement('style'); st.setAttribute('data-ed', ''); st.textContent = EDIT_CSS;
    doc.head.insertBefore(base, doc.head.firstChild);
    doc.head.appendChild(st);
    const fr = $('frame');
    fr.onload = () => { idoc = fr.contentDocument; prepare(); };
    fr.srcdoc = '<!doctype html>' + doc.documentElement.outerHTML;
    show('empty', false);
  }

  function prepare() {
    idoc.querySelectorAll('figure[data-img]').forEach((f) => {
      if (f.querySelector('img')) return;
      const i = idoc.createElement('img');
      i.setAttribute('data-ed-injected', ''); i.alt = '';
      i.src = 'images/' + f.dataset.img + '.webp';
      i.onerror = () => { if (!i.dataset.fb) { i.dataset.fb = 1; i.src = 'images/' + f.dataset.img + '.jpg'; } };
      f.appendChild(i);
    });
    idoc.body.querySelectorAll('*').forEach((el) => {
      if (SKIP.has(el.tagName) || el.closest('svg,select,script,style,[data-ed]')) return;
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return;
      if (INLINE.has(el.tagName) && el.parentElement && el.parentElement.closest('[contenteditable]')) return;
      el.setAttribute('contenteditable', 'true');
    });
    idoc.addEventListener('click', onClick, true);
    idoc.addEventListener('submit', (e) => e.preventDefault(), true);
    idoc.addEventListener('input', () => markDirty());
    idoc.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.ctrlKey) { e.preventDefault(); idoc.execCommand('insertLineBreak'); }
    });
    idoc.addEventListener('paste', (e) => {
      const t = e.clipboardData && e.clipboardData.getData('text/plain');
      if (t == null) return;
      e.preventDefault(); idoc.execCommand('insertText', false, t);
    });
    $('pTitle').value = idoc.title || '';
    const md = idoc.querySelector('meta[name="description"]');
    $('pDesc').value = md ? md.getAttribute('content') : '';
    clearSelection();
    dirty = false; refresh();
    status('Click any text to edit it.', 'ok');
  }

  function refresh() {
    $('publishBtn').disabled = !(dirty || pending.size);
    $('discardBtn').disabled = !(dirty || pending.size);
  }
  function markDirty() { dirty = true; refresh(); status(''); }
  window.addEventListener('beforeunload', (e) => { if (dirty || pending.size) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- clicking pictures and links ---------- */
  function clearSelection() {
    idoc && idoc.querySelectorAll('.ed-selected').forEach((n) => n.classList.remove('ed-selected'));
    selImg = selLink = null;
    show('sidePage', true); show('sideImg', false); show('sideLink', false);
  }
  function onClick(e) {
    const t = e.target;
    const img = t.closest && (t.closest('img') || (t.closest('figure[data-img]') && t.closest('figure[data-img]').querySelector('img')));
    const a = t.closest && t.closest('a');
    if (a) e.preventDefault();
    if (img) {
      e.preventDefault(); clearSelection();
      selImg = img; img.classList.add('ed-selected');
      $('thumb').src = img.currentSrc || img.src;
      $('iAlt').value = img.getAttribute('alt') || '';
      $('iAlt').disabled = img.hasAttribute('data-ed-injected');
      show('sidePage', false); show('sideImg', true);
    } else if (a) {
      clearSelection(); selLink = a;
      $('aHref').value = a.getAttribute('href') || '';
      show('sidePage', false); show('sideLink', true);
    } else if (!t.closest || !t.closest('[contenteditable]')) {
      clearSelection();
    }
  }
  $('iDone').onclick = $('aDone').onclick = clearSelection;
  $('iAlt').oninput = () => { if (selImg) { selImg.setAttribute('alt', $('iAlt').value); markDirty(); } };
  $('aHref').oninput = () => { if (selLink) { selLink.setAttribute('href', $('aHref').value.trim()); markDirty(); } };

  $('pTitle').oninput = () => {
    if (!idoc) return;
    const old = idoc.title, v = $('pTitle').value;
    const og = idoc.querySelector('meta[property="og:title"]');
    if (og && og.content === old) og.content = v;
    idoc.title = v; markDirty();
  };
  $('pDesc').oninput = () => {
    if (!idoc) return;
    const v = $('pDesc').value;
    const d = idoc.querySelector('meta[name="description"]');
    const og = idoc.querySelector('meta[property="og:description"]');
    if (og && d && og.content === d.content) og.content = v;
    if (d) d.content = v;
    markDirty();
  };

  /* ---------- replacing a picture ---------- */
  function resize(file, edge, mime) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), im = new Image();
      im.onload = () => {
        const k = Math.min(1, edge / Math.max(im.naturalWidth, im.naturalHeight));
        const w = Math.round(im.naturalWidth * k), h = Math.round(im.naturalHeight * k);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(im, 0, 0, w, h);
        c.toBlob((b) => { URL.revokeObjectURL(url); b ? res({ blob: b, w, h }) : rej(new Error('Could not read that picture.')); }, mime, 0.85);
      };
      im.onerror = () => rej(new Error('That file is not a picture the browser can open.'));
      im.src = url;
    });
  }
  $('iFile').onchange = async () => {
    const file = $('iFile').files[0]; $('iFile').value = '';
    if (!file || !selImg) return;
    try {
      status('Preparing picture...');
      const img = selImg, fig = img.closest('figure[data-img]');
      const jpg = await resize(file, 2000, 'image/jpeg');
      if (fig && img.hasAttribute('data-ed-injected')) {
        const webp = await resize(file, 2000, 'image/webp');
        const n = fig.dataset.img;
        pending.set(C.publishDir + 'images/' + n + '.jpg', jpg.blob);
        pending.set(C.publishDir + 'images/' + n + '.webp', webp.blob);
      } else {
        const slug = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'photo';
        const rel = 'images/uploads/' + Date.now() + '-' + slug + '.jpg';
        pending.set(C.publishDir + rel, jpg.blob);
        img.setAttribute('data-ed-src', '/' + rel);
        img.removeAttribute('srcset'); img.removeAttribute('sizes');
        if (img.parentElement && img.parentElement.tagName === 'PICTURE') img.parentElement.querySelectorAll('source').forEach((s) => s.remove());
        if (img.hasAttribute('width') && img.hasAttribute('height')) { img.setAttribute('width', jpg.w); img.setAttribute('height', jpg.h); }
      }
      img.onerror = null; img.removeAttribute('data-fb');
      img.src = URL.createObjectURL(jpg.blob);
      $('thumb').src = img.src;
      markDirty(); status('Picture ready. Press Publish to make it live.', 'ok');
    } catch (e) { status(e.message, 'bad'); }
  };

  /* ---------- toolbar ---------- */
  const fmt = (cmd, val) => { if (!idoc) return; $('frame').contentWindow.focus(); idoc.execCommand(cmd, false, val); markDirty(); };
  ['bBtn', 'iBtn', 'lBtn', 'ulBtn', 'undoBtn', 'redoBtn'].forEach((id) => $(id).addEventListener('mousedown', (e) => e.preventDefault()));
  $('bBtn').onclick = () => fmt('bold');
  $('iBtn').onclick = () => fmt('italic');
  $('undoBtn').onclick = () => fmt('undo');
  $('redoBtn').onclick = () => fmt('redo');
  $('ulBtn').onclick = () => fmt('unlink');
  $('lBtn').onclick = () => {
    if (!idoc) return;
    const sel = idoc.getSelection();
    if (!sel || sel.isCollapsed) { alert('First select the words that should become a link, then press Link.'); return; }
    const url = prompt('Where should the link go? (for example https://example.com)');
    if (url) fmt('createLink', url.trim());
  };

  /* ---------- save ---------- */
  function serialize() {
    const root = idoc.documentElement.cloneNode(true);
    root.querySelectorAll('[data-ed],[data-ed-injected]').forEach((n) => n.remove());
    root.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));
    root.querySelectorAll('.ed-selected').forEach((n) => { n.classList.remove('ed-selected'); if (!n.getAttribute('class')) n.removeAttribute('class'); });
    root.querySelectorAll('script[data-ed-type]').forEach((s) => {
      if (s.getAttribute('data-ed-had-type') === '1') s.setAttribute('type', s.getAttribute('data-ed-type')); else s.removeAttribute('type');
      s.removeAttribute('data-ed-type'); s.removeAttribute('data-ed-had-type');
    });
    root.querySelectorAll('img[data-ed-src]').forEach((i) => { i.setAttribute('src', i.getAttribute('data-ed-src')); i.removeAttribute('data-ed-src'); });
    root.querySelectorAll('img[src^="blob:"]').forEach((i) => i.removeAttribute('src'));
    // keep screen-reader labels in step with edited headlines, and counters in step with their numbers
    root.querySelectorAll('h1[aria-label],h2[aria-label],h3[aria-label]').forEach((h) => {
      if (h.querySelector('[aria-hidden="true"]')) h.setAttribute('aria-label', h.textContent.replace(/\s+/g, ' ').trim());
    });
    root.querySelectorAll('[data-count]').forEach((n) => { const v = parseInt(n.textContent.replace(/[^\d]/g, ''), 10); if (isFinite(v)) n.setAttribute('data-count', v); });
    return '<!doctype html>\n' + root.outerHTML + '\n';
  }
  window.__serialize = () => idoc && serialize();

  async function putFile(path, b64, message) {
    let sha;
    try { sha = (await gh('/repos/' + C.repo + '/contents/' + encPath(path) + '?ref=' + encodeURIComponent(C.branch))).sha; } catch (e) { if (e.status !== 404) throw e; }
    return gh('/repos/' + C.repo + '/contents/' + encPath(path), {
      method: 'PUT',
      body: JSON.stringify({ message, content: b64, branch: C.branch, sha })
    });
  }

  $('publishBtn').onclick = async () => {
    if (!page || !idoc) return;
    const btn = $('publishBtn'); btn.disabled = true;
    try {
      const html = serialize();
      if (LOCAL) { window.__lastSerialized = html; status('Test mode: not sent to GitHub (' + html.length + ' characters).', 'ok'); return; }
      status('Publishing...');
      for (const [path, blob] of pending) await putFile(path, await blobToB64(blob), 'Editor: add picture ' + path.split('/').pop());
      const res = await gh('/repos/' + C.repo + '/contents/' + encPath(page.path), {
        method: 'PUT',
        body: JSON.stringify({ message: 'Editor: update ' + liveUrl(page.path), content: utf8ToB64(html), sha: page.sha, branch: C.branch })
      });
      page.sha = res.content.sha; pending = new Map(); dirty = false; refresh();
      status('Published. The live site updates in about a minute.', 'ok');
    } catch (e) {
      status(e.status === 409 || e.status === 422 ? 'This page was changed somewhere else since you opened it. Reload the page (F5) and make your edit again.' : 'Could not publish: ' + e.message, 'bad');
      refresh();
    }
  };
  $('discardBtn').onclick = () => {
    if (!page || !confirm('Throw away everything you changed on this page since you opened it?')) return;
    dirty = false; pending = new Map(); openPage(page.path);
  };
  $('viewBtn').onclick = () => { if (page) window.open(location.origin + liveUrl(page.path), '_blank', 'noopener'); };

  /* ---------- start ---------- */
  async function start() {
    show('login', false); show('app', true);
    $('siteName').textContent = C.siteName + ' editor';
    try { allPages = (await listPages()).sort((a, b) => (a === C.publishDir + 'index.html' ? -1 : b === C.publishDir + 'index.html' ? 1 : a.localeCompare(b))); }
    catch (e) { status('Could not list pages: ' + e.message, 'bad'); return; }
    const home = C.publishDir + 'index.html';
    if (allPages.includes(home)) openPage(home);
  }

  (async () => {
    document.title = C.siteName + ' editor';
    $('loginTitle').textContent = C.siteName + ' editor';
    if (LOCAL) { await start(); return; }
    const t = store.get();
    if (t) { try { await signIn(t); await start(); return; } catch (e) { store.set(''); } }
    show('login', true);
  })();
})();
