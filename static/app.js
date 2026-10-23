"use strict";

(() => {
  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  const $ = (sel, el = document) => el.querySelector(sel);

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem("lfr." + key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem("lfr." + key, JSON.stringify(value)); } catch { /* ignore */ }
    },
  };

  const DEFAULTS = {
    showHidden: false,
    wrap: false,
    lineNumbers: true,
    autoRefresh: false,
    htmlScripts: false,
    theme: "auto",
    fontSize: "13",
  };
  const settings = { ...DEFAULTS, ...store.get("settings", {}) };

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k === "dataset") Object.assign(node.dataset, v);
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
    }
    node.append(...children.filter((c) => c !== null && c !== undefined));
    return node;
  };

  const svg = (markup, cls = "") => {
    const t = document.createElement("template");
    t.innerHTML = `<svg viewBox="0 0 24 24" class="${cls}">${markup}</svg>`;
    return t.content.firstChild;
  };
  const ICON = {
    chevron: '<path d="m9 6 6 6-6 6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    broken: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="m10 12 4 4m0-4-4 4"/>',
  };

  const escapeHtml = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const formatSize = (n) => {
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
  };

  // Paths are always POSIX-style absolute paths.
  const joinPath = (dir, name) => (dir === "/" ? "/" + name : dir + "/" + name);
  const dirname = (p) => {
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.slice(0, i);
  };
  const basename = (p) => (p === "/" ? "/" : p.slice(p.lastIndexOf("/") + 1));
  const isInside = (p, root) => root === "/" || p === root || p.startsWith(root + "/");
  const normalize = (p) => {
    const out = [];
    for (const part of p.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return "/" + out.join("/");
  };
  const tildify = (p) => {
    const home = state.config?.home;
    return home && isInside(p, home) && home !== "/" ? "~" + p.slice(home.length) : p;
  };

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard API needs a secure context; plain http over the LAN isn't one.
      const ta = el("textarea", { style: "position:fixed;opacity:0" });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  }

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  async function api(endpoint, params = {}) {
    const res = await fetch(`${endpoint}?${new URLSearchParams(params)}`, { cache: "no-store" });
    if (res.status === 401) {
      location.href = "/login";
      throw new Error("login required");
    }
    const data = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  const rawUrl = (path, version) =>
    `/raw/${state.config.rawKey}${path.split("/").map(encodeURIComponent).join("/")}` +
    (version ? `?v=${version}` : "");

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const state = {
    config: null,
    root: null,
    file: null,
    data: null,
    view: "rendered", // or "source" for markdown/html/svg/csv
    jsonPretty: false,
    expanded: new Set(),
    dirCache: new Map(),
    loadToken: 0,
    pollTimer: null,
    pendingAnchor: null,
    line: null, // 1-based line to scroll to and highlight
    lineMarks: null, // [start, end) ranges within that line to highlight
  };

  const dom = {
    layout: $("#layout"),
    tree: $("#tree"),
    treeTitle: $("#tree-title"),
    search: $("#search"),
    results: $("#search-results"),
    viewer: $("#viewer"),
    viewerHead: $("#viewer-head"),
    crumbs: $("#crumbs"),
    meta: $("#viewer-meta"),
    actions: $("#viewer-actions"),
    rootLabel: $("#root-label"),
    settings: $("#settings"),
    picker: $("#picker"),
  };

  const mobile = window.matchMedia("(max-width: 760px)");

  // ---------------------------------------------------------------------------
  // URL state: ?root=/dir&file=/dir/file
  // ---------------------------------------------------------------------------

  function writeUrl(push) {
    const params = new URLSearchParams();
    if (state.root) params.set("root", state.root);
    if (state.file) params.set("file", state.file);
    if (state.file && state.line) params.set("line", state.line);
    const url = `${location.pathname}?${params}`.replace(/\?$/, "") + location.hash;
    if (url === location.pathname + location.search + location.hash) return;
    history[push ? "pushState" : "replaceState"](null, "", url);
  }

  async function applyUrl() {
    const params = new URLSearchParams(location.search);
    const root = params.get("root") || store.get("lastRoot", null);
    const file = params.get("file");
    const line = Number(params.get("line")) || null;
    if (root && root !== state.root) {
      const ok = await setRoot(root, { push: false, keepFile: true });
      if (!ok && !file) return openPicker();
    }
    if (file && (file !== state.file || line !== state.line)) await openFile(file, { push: false, line });
    else if (!file && state.file) clearViewer();
    if (!state.root && !file) openPicker();
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  function applyTheme() {
    const dark = settings.theme === "dark" || (settings.theme === "auto" && darkQuery.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    $("#hljs-light").disabled = dark;
    $("#hljs-dark").disabled = !dark;
  }

  function applySetting(key) {
    switch (key) {
      case "theme": return applyTheme();
      case "fontSize": return document.documentElement.style.setProperty("--code-size", settings.fontSize + "px");
      case "wrap": return dom.viewer.classList.toggle("wrap", settings.wrap);
      case "lineNumbers": return dom.viewer.classList.toggle("ln", settings.lineNumbers);
      case "autoRefresh": return schedulePoll();
      case "htmlScripts":
        if (state.data && fileType(state.data) === "html") renderFile();
        return;
      case "showHidden":
        $("#picker-hidden").checked = settings.showHidden;
        if (state.root) refreshTree();
        return;
    }
  }

  function initSettings() {
    for (const input of dom.settings.querySelectorAll("[data-setting]")) {
      const key = input.dataset.setting;
      if (input.type === "checkbox") input.checked = settings[key];
      else input.value = settings[key];
      input.addEventListener("change", () => {
        settings[key] = input.type === "checkbox" ? input.checked : input.value;
        store.set("settings", settings);
        applySetting(key);
      });
    }
    Object.keys(DEFAULTS).forEach(applySetting);
    darkQuery.addEventListener("change", applyTheme);

    $("#btn-settings").addEventListener("click", (e) => {
      e.stopPropagation();
      dom.settings.hidden = !dom.settings.hidden;
    });
    document.addEventListener("click", (e) => {
      if (!dom.settings.hidden && !dom.settings.contains(e.target)) dom.settings.hidden = true;
    });
  }

  // ---------------------------------------------------------------------------
  // Layout: resizable splitter, collapsible tree / mobile drawer
  // ---------------------------------------------------------------------------

  const DEFAULT_TREE_WIDTH = 300;

  function setTreeWidth(px, save) {
    const max = Math.max(200, dom.layout.clientWidth - 240);
    const w = Math.round(Math.min(Math.max(px, 160), max));
    document.documentElement.style.setProperty("--tree-width", w + "px");
    if (save) store.set("treeWidth", w);
  }

  function initLayout() {
    setTreeWidth(store.get("treeWidth", DEFAULT_TREE_WIDTH), false);
    dom.layout.classList.toggle("tree-hidden", store.get("treeHidden", false));

    const splitter = $("#splitter");
    splitter.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      splitter.setPointerCapture(e.pointerId);
      splitter.classList.add("dragging");
      document.body.classList.add("resizing");
      const left = dom.layout.getBoundingClientRect().left;
      const move = (ev) => setTreeWidth(ev.clientX - left, false);
      const up = (ev) => {
        splitter.releasePointerCapture(ev.pointerId);
        splitter.removeEventListener("pointermove", move);
        splitter.removeEventListener("pointerup", up);
        splitter.classList.remove("dragging");
        document.body.classList.remove("resizing");
        setTreeWidth(ev.clientX - left, true);
      };
      splitter.addEventListener("pointermove", move);
      splitter.addEventListener("pointerup", up);
    });
    splitter.addEventListener("dblclick", () => setTreeWidth(DEFAULT_TREE_WIDTH, true));
    splitter.addEventListener("keydown", (e) => {
      const cur = $("#tree-panel").getBoundingClientRect().width;
      if (e.key === "ArrowLeft") setTreeWidth(cur - 20, true);
      else if (e.key === "ArrowRight") setTreeWidth(cur + 20, true);
    });

    $("#btn-toggle-tree").addEventListener("click", () => {
      if (mobile.matches) {
        dom.layout.classList.toggle("drawer-open");
      } else {
        const hidden = dom.layout.classList.toggle("tree-hidden");
        store.set("treeHidden", hidden);
      }
    });
    $("#scrim").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      dom.settings.hidden = true;
      closeDrawer();
    });
  }

  const closeDrawer = () => dom.layout.classList.remove("drawer-open");
  const openDrawer = () => mobile.matches && dom.layout.classList.add("drawer-open");

  // ---------------------------------------------------------------------------
  // File tree
  // ---------------------------------------------------------------------------

  function loadDir(path) {
    if (!state.dirCache.has(path)) {
      const p = api("/api/list", { path, hidden: settings.showHidden ? 1 : 0 }).then(
        (d) => ({ entries: d.entries }),
        (e) => ({ error: e.message }),
      );
      state.dirCache.set(path, p);
    }
    return state.dirCache.get(path);
  }

  const findItem = (path) => dom.tree.querySelector(`li[data-path="${CSS.escape(path)}"]`);

  function makeItem(dir, entry, depth) {
    const path = joinPath(dir, entry.name);
    const isDir = entry.type === "dir";
    const row = el(
      "button",
      {
        class: "tree-row" + (entry.hidden ? " hidden-file" : "") + (entry.type === "broken" ? " broken" : ""),
        type: "button",
        role: "treeitem",
        title: path,
        style: `--depth:${depth}`,
        "aria-expanded": isDir ? "false" : null,
      },
      svg(ICON.chevron, "chev" + (isDir ? "" : " none")),
      svg(isDir ? ICON.folder : entry.type === "broken" ? ICON.broken : ICON.file, "ico" + (isDir ? " folder" : "")),
      el("span", { class: "name" }, entry.name),
      entry.link ? el("span", { class: "link-mark", title: "Symbolic link" }, "↪") : null,
    );
    return el(
      "li",
      { dataset: { path, type: entry.type, name: entry.name.toLowerCase(), depth } },
      row,
    );
  }

  const treeNote = (text, depth, error) =>
    el("li", { class: "tree-note" + (error ? " error" : ""), style: `--depth:${depth}` }, text);

  async function fillDir(ul, dir, depth) {
    ul.replaceChildren(treeNote("Loading…", depth));
    const res = await loadDir(dir);
    ul.replaceChildren();
    if (res.error) return ul.append(treeNote(res.error, depth, true));
    if (!res.entries.length) return ul.append(treeNote("Empty", depth));
    const frag = document.createDocumentFragment();
    for (const entry of res.entries) frag.append(makeItem(dir, entry, depth));
    ul.append(frag);
    markActive();
    // Re-open directories that were expanded before (persisted per root).
    const reopen = [...ul.children].filter((li) => li.dataset.type === "dir" && state.expanded.has(li.dataset.path));
    await Promise.all(reopen.map((li) => setExpanded(li, true)));
  }

  async function setExpanded(li, open) {
    const path = li.dataset.path;
    const row = li.firstElementChild;
    let ul = li.querySelector(":scope > ul");
    row.setAttribute("aria-expanded", String(open));
    row.querySelector(".chev").classList.toggle("open", open);
    if (open) {
      state.expanded.add(path);
      if (!ul) {
        ul = el("ul", { role: "group" });
        li.append(ul);
        await fillDir(ul, path, Number(li.dataset.depth) + 1);
      } else {
        ul.hidden = false;
      }
    } else {
      state.expanded.delete(path);
      if (ul) ul.hidden = true;
    }
    saveExpanded();
  }

  function saveExpanded() {
    store.set("expanded:" + state.root, [...state.expanded].slice(-500));
  }

  async function renderTree() {
    const ul = el("ul", { role: "group" });
    dom.tree.replaceChildren(ul);
    await fillDir(ul, state.root, 0);
  }

  function refreshTree() {
    state.dirCache.clear();
    buildIndex();
    if (searchMode === "contents" && dom.search.value.trim()) runGrep();
    const scroll = dom.tree.scrollTop;
    return renderTree().then(() => {
      dom.tree.scrollTop = scroll;
      if (state.file) revealPath(state.file, false);
    });
  }

  function markActive() {
    for (const li of dom.results.querySelectorAll("li.result")) li.classList.toggle("current", li.dataset.path === state.file);
    for (const row of dom.tree.querySelectorAll(".tree-row.active")) row.classList.remove("active");
    if (!state.file) return;
    const li = findItem(state.file);
    if (li) li.firstElementChild.classList.add("active");
  }

  // Expand every ancestor of `path` (and `path` itself when expandSelf) and
  // scroll it into view.
  async function revealPath(path, expandSelf) {
    if (!state.root || !isInside(path, state.root)) return null;
    const rel = state.root === "/" ? path.slice(1) : path.slice(state.root.length + 1);
    const parts = rel ? rel.split("/") : [];
    let cur = state.root;
    let li = null;
    for (let i = 0; i < parts.length; i++) {
      cur = joinPath(cur, parts[i]);
      li = findItem(cur);
      if (!li) return null;
      const last = i === parts.length - 1;
      if (li.dataset.type === "dir" && (!last || expandSelf)) await setExpanded(li, true);
    }
    if (li) li.firstElementChild.scrollIntoView({ block: "nearest" });
    markActive();
    return li;
  }

  function initTree() {
    dom.tree.addEventListener("click", (e) => {
      const row = e.target.closest(".tree-row");
      if (!row) return;
      const li = row.parentElement;
      const type = li.dataset.type;
      if (type === "dir") setExpanded(li, row.getAttribute("aria-expanded") !== "true");
      else if (type === "file") openFile(li.dataset.path);
    });
    dom.tree.addEventListener("keydown", (e) => {
      const row = e.target.closest(".tree-row");
      if (!row) return;
      const rows = [...dom.tree.querySelectorAll(".tree-row")].filter((r) => r.offsetParent !== null);
      const i = rows.indexOf(row);
      const li = row.parentElement;
      const isDir = li.dataset.type === "dir";
      const open = row.getAttribute("aria-expanded") === "true";
      if (e.key === "ArrowDown") rows[i + 1]?.focus();
      else if (e.key === "ArrowUp") rows[i - 1]?.focus();
      else if (e.key === "ArrowRight" && isDir && !open) setExpanded(li, true);
      else if (e.key === "ArrowLeft" && isDir && open) setExpanded(li, false);
      else if (e.key === "ArrowLeft") li.parentElement.closest("li")?.firstElementChild.focus();
      else return;
      e.preventDefault();
    });
    $("#btn-refresh-tree").addEventListener("click", () => state.root && refreshTree());
    $("#btn-collapse-all").addEventListener("click", () => {
      state.expanded.clear();
      saveExpanded();
      for (const li of dom.tree.querySelectorAll('li[data-type="dir"]')) {
        li.firstElementChild.setAttribute("aria-expanded", "false");
        li.querySelector(".chev").classList.remove("open");
        const ul = li.querySelector(":scope > ul");
        if (ul) ul.hidden = true;
      }
    });
  }

  async function setRoot(path, { push = true, keepFile = false } = {}) {
    let listing;
    try {
      listing = await api("/api/list", { path, hidden: 0 });
    } catch (e) {
      showError(`Cannot open ${path}: ${e.message}`);
      return false;
    }
    state.root = listing.path;
    state.dirCache.clear();
    state.expanded = new Set(store.get("expanded:" + state.root, []));
    store.set("lastRoot", state.root);
    const recent = store.get("recentRoots", []).filter((p) => p !== state.root);
    store.set("recentRoots", [state.root, ...recent].slice(0, 8));

    // LRM marks keep the leading "/" in place under the rtl ellipsis trick.
    dom.rootLabel.textContent = "\u200e" + tildify(state.root) + "\u200e";
    dom.rootLabel.parentElement.title = state.root;
    dom.treeTitle.textContent = basename(state.root);
    clearSearch();

    if (!keepFile || !state.file || !isInside(state.file, state.root)) clearViewer();
    writeUrl(push);
    buildIndex();
    await renderTree();
    if (state.file) revealPath(state.file, false);
    else openDrawer();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Filename index & search
  // ---------------------------------------------------------------------------

  const RESULT_LIMIT = 200;

  const search = {
    root: null,
    entries: [], // { rel, lrel, nameStart, isDir, depth }
    counts: null,
    truncated: false,
    loading: false,
    error: null,
    token: 0,
    results: [],
    total: 0,
    selected: 0,
    timer: null,
  };

  async function buildIndex() {
    const token = ++search.token;
    Object.assign(search, { root: state.root, entries: [], counts: null, loading: true, error: null });
    updateSearchStatus();
    try {
      const data = await api("/api/index", { path: state.root, hidden: settings.showHidden ? 1 : 0 });
      if (token !== search.token) return;
      const entries = [];
      const add = (rel, isDir) => {
        const lrel = rel.toLowerCase();
        let depth = 0;
        for (let i = rel.indexOf("/"); i !== -1; i = rel.indexOf("/", i + 1)) depth++;
        entries.push({ rel, lrel, nameStart: rel.lastIndexOf("/") + 1, isDir, depth });
      };
      for (const rel of data.dirs) add(rel, true);
      for (const rel of data.files) add(rel, false);
      search.entries = entries;
      search.counts = { files: data.files.length, dirs: data.dirs.length, elapsed: data.elapsed };
      search.truncated = data.truncated;
    } catch (e) {
      if (token !== search.token) return;
      search.error = e.message;
    }
    search.loading = false;
    if (searchMode === "names") runSearch();
    else updateSearchStatus();
  }

  const isSubsequence = (needle, hay) => fuzzySpan(needle, hay) !== -1;

  // Length of the window in `hay` covering a greedy subsequence match of
  // `needle`, or -1 if there is none. Smaller means a tighter match.
  function fuzzySpan(needle, hay) {
    let j = 0;
    let first = -1;
    for (let i = 0; i < hay.length; i++) {
      if (hay[i] !== needle[j]) continue;
      if (j === 0) first = i;
      if (++j === needle.length) return i - first + 1;
    }
    return -1;
  }

  // Higher is better; -1 means no match. Name matches beat path matches, which
  // beat fuzzy (subsequence) matches. Fuzzy matching is limited to the file
  // name: across a whole path almost any short query matches something.
  function scoreTerm(term, e) {
    const name = e.lrel.slice(e.nameStart);
    if (name === term) return 1000;
    if (name.startsWith(term)) return 800;
    if (name.includes(term)) return 600;
    if (e.lrel.includes(term)) return 300;
    if (term.length > 1) {
      const span = fuzzySpan(term, name);
      if (span !== -1) return 50 + Math.round((150 * term.length) / span);
    }
    return -1;
  }

  function runSearch() {
    const q = dom.search.value.trim().toLowerCase();
    const active = Boolean(q);
    dom.tree.hidden = active;
    dom.results.hidden = !active;
    if (!active) {
      search.results = [];
      updateSearchStatus();
      return;
    }
    const terms = q.split(/\s+/);
    const matches = [];
    for (const e of search.entries) {
      let score = 0;
      for (const t of terms) {
        const s = scoreTerm(t, e);
        if (s < 0) { score = -1; break; }
        score += s;
      }
      if (score >= 0) matches.push({ e, score: score - e.depth * 4 - e.rel.length * 0.05 });
    }
    matches.sort((a, b) => b.score - a.score || a.e.rel.localeCompare(b.e.rel));
    search.total = matches.length;
    search.results = matches.slice(0, RESULT_LIMIT).map((m) => m.e);
    search.selected = 0;
    search.terms = terms;
    renderResults();
    updateSearchStatus();
  }

  // Indices in `text` (already lowercase) to highlight for the query terms.
  function highlightIndices(text, terms) {
    const marks = new Set();
    for (const t of terms) {
      const at = text.indexOf(t);
      if (at !== -1) {
        for (let i = at; i < at + t.length; i++) marks.add(i);
      } else if (isSubsequence(t, text)) {
        for (let i = 0, j = 0; i < text.length && j < t.length; i++) if (text[i] === t[j]) { marks.add(i); j++; }
      }
    }
    return marks;
  }

  function markup(text, marks) {
    let out = "";
    let open = false;
    for (let i = 0; i < text.length; i++) {
      const m = marks.has(i);
      if (m !== open) { out += m ? "<mark>" : "</mark>"; open = m; }
      out += escapeHtml(text[i]);
    }
    return out + (open ? "</mark>" : "");
  }

  function renderResults() {
    const frag = document.createDocumentFragment();
    search.results.forEach((e, i) => {
      const name = e.rel.slice(e.nameStart);
      const dir = e.nameStart ? e.rel.slice(0, e.nameStart - 1) : "";
      const nameEl = el("span", { class: "r-name" });
      nameEl.innerHTML = markup(name, highlightIndices(name.toLowerCase(), search.terms));
      const text = el("span", { class: "r-text" }, nameEl);
      if (dir) {
        const dirEl = el("span", { class: "r-dir", title: dir });
        // LRM marks keep leading/trailing slashes in place under direction: rtl.
        dirEl.innerHTML = "‎" + markup(dir, highlightIndices(dir.toLowerCase(), search.terms)) + "‎";
        text.append(dirEl);
      }
      frag.append(el("li", {
        class: "result" + (i === search.selected ? " selected" : ""),
        role: "option",
        title: e.rel,
        dataset: { kind: e.isDir ? "dir" : "file", path: joinPath(search.root, e.rel), key: e.rel },
      }, svg(e.isDir ? ICON.folder : ICON.file, "ico" + (e.isDir ? " folder" : "")), text));
    });
    if (!search.results.length && !search.loading) {
      frag.append(el("li", { class: "r-note" }, search.error ? "Index unavailable" : "No matching files"));
    }
    dom.results.replaceChildren(frag);
    dom.results.scrollTop = 0;
    markActive();
  }

  function updateSearchStatus() {
    const status = $("#search-status");
    if (searchMode === "contents") {
      const text = grepStatus();
      status.classList.toggle("error", Boolean(grep.error));
      status.textContent = text;
      status.title = text;
      return;
    }
    status.classList.toggle("error", Boolean(search.error));
    const fmt = (n) => n.toLocaleString();
    let text = "";
    if (search.loading) text = "Indexing file names…";
    else if (search.error) text = `Indexing failed: ${search.error}`;
    else if (search.counts) {
      const { files, dirs, elapsed } = search.counts;
      text = dom.search.value.trim()
        ? `${search.total > RESULT_LIMIT ? `Top ${RESULT_LIMIT} of ` : ""}${fmt(search.total)} match${search.total === 1 ? "" : "es"}`
        : `${fmt(files)} files, ${fmt(dirs)} folders indexed${elapsed >= 0.1 ? ` in ${elapsed.toFixed(1)}s` : ""}`;
      if (search.truncated) text += " · index limit reached";
    }
    if (search.loading && dom.search.value.trim()) text += " (results will update)";
    status.textContent = text;
    status.title = text;
  }

  function selectResult(i) {
    const items = dom.results.querySelectorAll("li.result");
    if (!items.length) return;
    search.selected = (i + items.length) % items.length;
    items.forEach((li, j) => li.classList.toggle("selected", j === search.selected));
    items[search.selected].scrollIntoView({ block: "nearest" });
  }

  function openResult(li) {
    selectResult([...dom.results.querySelectorAll("li.result")].indexOf(li));
    const { kind, path } = li.dataset;
    if (kind === "dir") {
      clearSearch();
      revealPath(path, true);
    } else if (kind === "gfile" || kind === "gline") {
      const line = Number(li.dataset.line) || null;
      const m = grep.files.find((f) => f.path === li.dataset.rel)?.lines.find((l) => l.line === line);
      // Snippet ranges are relative to the snippet; shift them onto the full line.
      const marks = m ? m.ranges.map(([s, e]) => [s + m.col, e + m.col]) : null;
      openFile(path, { line, marks });
    } else {
      openFile(path);
    }
  }

  function clearSearch() {
    dom.search.value = "";
    stopGrep();
    rerunSearch();
  }

  function initSearch() {
    dom.search.addEventListener("input", () => {
      clearTimeout(search.timer);
      clearTimeout(grep.timer);
      if (searchMode === "names") {
        search.timer = setTimeout(runSearch, search.entries.length > 50000 ? 120 : 40);
        return;
      }
      // Content searches cost a walk of the whole tree: wait for a pause in
      // typing, and only search single characters when Enter is pressed.
      const q = dom.search.value.trim();
      if (!q || q.length >= 2) grep.timer = setTimeout(runGrep, q ? 300 : 0);
      else {
        stopGrep();
        updateSearchStatus();
      }
    });
    dom.search.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") selectResult(search.selected + 1);
      else if (e.key === "ArrowUp") selectResult(search.selected - 1);
      else if (e.key === "Enter" && searchMode === "contents" && grep.query !== dom.search.value) runGrep();
      else if (e.key === "Enter") {
        clearTimeout(search.timer);
        const stale = search.terms?.join(" ") !== dom.search.value.trim().toLowerCase().split(/\s+/).join(" ");
        if (searchMode === "names" && stale) runSearch();
        const li = dom.results.querySelectorAll("li.result")[search.selected];
        if (li) openResult(li);
      } else if (e.key === "Escape") {
        if (!dom.search.value) return dom.search.blur();
        e.stopPropagation();
        clearSearch();
      } else return;
      e.preventDefault();
    });
    dom.results.addEventListener("click", (e) => {
      const more = e.target.closest("li.g-more");
      if (more) {
        grep.expanded.add(more.dataset.rel);
        return renderGrep();
      }
      const li = e.target.closest("li.result");
      if (!li) return;
      if (li.classList.contains("g-file") && e.target.closest(".chev")) {
        const rel = li.dataset.rel;
        if (!grep.collapsed.delete(rel)) grep.collapsed.add(rel);
        return renderGrep();
      }
      openResult(li);
    });
    // "/" or Ctrl/Cmd+K focuses search from anywhere; Ctrl/Cmd+Shift+F
    // switches to content search, seeded with any selected text.
    document.addEventListener("keydown", (e) => {
      const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      const slash = e.key === "/" && !typing && !mod && !e.altKey;
      const ctrlK = key === "k" && mod && !e.shiftKey;
      const findInFiles = key === "f" && mod && e.shiftKey;
      if ((!slash && !ctrlK && !findInFiles) || dom.picker.open || !state.root) return;
      e.preventDefault();
      if (findInFiles) {
        const selected = String(getSelection()).trim();
        if (selected && !selected.includes("\n") && selected.length <= 200) dom.search.value = selected;
        setSearchMode("contents");
      }
      if (dom.layout.classList.contains("tree-hidden") && !mobile.matches) {
        dom.layout.classList.remove("tree-hidden");
        store.set("treeHidden", false);
      }
      openDrawer();
      dom.search.focus();
      dom.search.select();
    });
  }

  // ---------------------------------------------------------------------------
  // Content search, streamed from /api/grep as NDJSON
  // ---------------------------------------------------------------------------

  const GREP_LINES_SHOWN = 3; // per file, until "+N more" is clicked
  const GREP_FILES_SHOWN = 500;

  const grep = {
    controller: null,
    query: null,
    files: [],
    progress: null,
    done: null,
    running: false,
    error: null,
    expanded: new Set(),
    collapsed: new Set(),
    renderTimer: null,
    timer: null,
  };
  const grepOpts = { case: false, word: false, regex: false, all: false, ...store.get("grepOpts", {}) };
  let searchMode = store.get("searchMode", "names");

  function stopGrep() {
    clearTimeout(grep.timer);
    grep.controller?.abort();
    grep.controller = null;
    grep.running = false;
  }

  async function runGrep() {
    stopGrep();
    const q = dom.search.value;
    const active = Boolean(q.trim());
    dom.tree.hidden = active;
    dom.results.hidden = !active;
    Object.assign(grep, {
      query: q, files: [], progress: null, done: null, error: null,
      expanded: new Set(), collapsed: new Set(),
    });
    dom.results.replaceChildren();
    if (!active) return updateSearchStatus();

    const controller = new AbortController();
    grep.controller = controller;
    grep.running = true;
    updateSearchStatus();
    const params = { path: state.root, q, hidden: settings.showHidden ? 1 : 0 };
    for (const k of ["case", "word", "regex", "all"]) if (grepOpts[k]) params[k] = 1;
    try {
      const res = await fetch(`/api/grep?${new URLSearchParams(params)}`, { signal: controller.signal, cache: "no-store" });
      if (res.status === 401) {
        location.href = "/login";
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || res.statusText);
      }
      // One JSON object per line; a chunk can end mid-line, so buffer.
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line) handleGrepEvent(JSON.parse(line));
        }
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      grep.error = e.message;
    }
    if (controller !== grep.controller) return;
    grep.controller = null;
    grep.running = false;
    clearTimeout(grep.renderTimer);
    grep.renderTimer = null;
    renderGrep();
    updateSearchStatus();
  }

  function handleGrepEvent(ev) {
    if (ev.type === "file") {
      grep.files.push(ev);
      // Re-rank and redraw at most every 150ms while results stream in.
      grep.renderTimer ??= setTimeout(() => {
        grep.renderTimer = null;
        renderGrep();
        updateSearchStatus();
      }, 150);
    } else if (ev.type === "progress") {
      grep.progress = ev;
      updateSearchStatus();
    } else if (ev.type === "done") {
      grep.done = ev;
    }
  }

  // HTML for `text` with the given [start, end) ranges wrapped in <mark>.
  function markRanges(text, ranges) {
    let out = "";
    let at = 0;
    for (const [s, e] of ranges) {
      if (s < at) continue;
      out += escapeHtml(text.slice(at, s)) + "<mark>" + escapeHtml(text.slice(s, e)) + "</mark>";
      at = e;
    }
    return out + escapeHtml(text.slice(at));
  }

  function renderGrep() {
    const scroll = dom.results.scrollTop;
    const selectedKey = dom.results.querySelector("li.result.selected")?.dataset.key;
    const files = [...grep.files].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const frag = document.createDocumentFragment();
    for (const f of files.slice(0, GREP_FILES_SHOWN)) {
      const path = joinPath(state.root, f.path);
      const slash = f.path.lastIndexOf("/");
      const dir = slash > 0 ? f.path.slice(0, slash) : "";
      const collapsed = grep.collapsed.has(f.path);
      const nameEl = el("span", { class: "r-name" });
      nameEl.innerHTML = markRanges(f.path.slice(slash + 1), f.nameRanges);
      const text = el("span", { class: "r-text" }, nameEl);
      if (dir) text.append(el("span", { class: "r-dir", title: dir }, "‎" + dir + "‎"));
      frag.append(el("li", {
        class: "result g-file" + (collapsed ? " collapsed" : ""),
        role: "option",
        title: f.path,
        dataset: { kind: "gfile", path, rel: f.path, line: f.lines[0]?.line ?? "", key: f.path },
      }, svg(ICON.chevron, "chev"), svg(ICON.file, "ico"), text,
      el("span", { class: "g-count", title: `${f.count} match${f.count === 1 ? "" : "es"}` }, String(f.count))));
      if (collapsed) continue;

      const shown = grep.expanded.has(f.path) ? f.lines : f.lines.slice(0, GREP_LINES_SHOWN);
      for (const m of shown) {
        const t = el("span", { class: "g-text" });
        t.innerHTML = (m.cut ? "…" : "") + markRanges(m.text, m.ranges) + (m.more ? "…" : "");
        frag.append(el("li", {
          class: "result g-line",
          role: "option",
          title: `${f.path}:${m.line}`,
          dataset: { kind: "gline", path, rel: f.path, line: m.line, key: `${f.path}:${m.line}` },
        }, el("span", { class: "g-ln" }, String(m.line)), t));
      }
      if (shown.length < f.lines.length) {
        const n = f.lines.length - shown.length;
        frag.append(el("li", { class: "g-more", dataset: { rel: f.path } }, `+${n} more line${n === 1 ? "" : "s"}`));
      }
    }
    if (files.length > GREP_FILES_SHOWN) {
      frag.append(el("li", { class: "r-note" }, `${files.length - GREP_FILES_SHOWN} more files not shown; refine the search.`));
    }
    if (!files.length && !grep.running) {
      frag.append(el("li", { class: "r-note" }, grep.error ? "Search failed" : "No matches"));
    }
    dom.results.replaceChildren(frag);
    dom.results.scrollTop = scroll;

    const items = [...dom.results.querySelectorAll("li.result")];
    const keep = items.findIndex((li) => li.dataset.key === selectedKey);
    search.selected = Math.max(keep, 0);
    items[search.selected]?.classList.add("selected");
    markActive();
  }

  function grepStatus() {
    const fmt = (n) => n.toLocaleString();
    const plural = (n, word, suffix = "s") => `${fmt(n)} ${word}${n === 1 ? "" : suffix}`;
    const q = dom.search.value.trim();
    if (!q) return "Search inside Markdown files under this folder";
    if (grep.error) return grep.error;
    if (grep.query !== dom.search.value) return q.length < 2 ? "Press Enter to search" : "";
    const matches = grep.files.reduce((n, f) => n + f.count, 0);
    const found = `${plural(matches, "match", "es")} in ${plural(grep.files.length, "file")}`;
    if (grep.running) return `Searching… ${fmt(grep.progress?.searched ?? 0)} files scanned · ${found}`;
    const d = grep.done;
    if (!d) return found;
    let text = `${found} · ${fmt(d.searched)} Markdown files searched in ${d.elapsed.toFixed(1)}s`;
    if (d.truncated) text += " · stopped early (limit reached)";
    if (d.skippedLarge) text += ` · ${plural(d.skippedLarge, "large file")} skipped`;
    return text;
  }

  function setSearchMode(mode) {
    searchMode = mode;
    store.set("searchMode", mode);
    $("#search-box").classList.toggle("contents", mode === "contents");
    for (const b of document.querySelectorAll("[data-mode]")) b.classList.toggle("on", b.dataset.mode === mode);
    dom.search.placeholder = mode === "contents" ? "Search in Markdown files…  (Ctrl+Shift+F)" : "Search file names…  ( / )";
    stopGrep();
    rerunSearch();
  }

  const rerunSearch = () => (searchMode === "contents" ? runGrep() : runSearch());

  function initGrep() {
    for (const b of document.querySelectorAll("[data-mode]")) {
      b.addEventListener("click", () => {
        setSearchMode(b.dataset.mode);
        dom.search.focus();
      });
    }
    for (const b of document.querySelectorAll("[data-opt]")) {
      const key = b.dataset.opt;
      b.setAttribute("aria-pressed", String(grepOpts[key]));
      b.addEventListener("click", () => {
        grepOpts[key] = !grepOpts[key];
        store.set("grepOpts", grepOpts);
        b.setAttribute("aria-pressed", String(grepOpts[key]));
        if (dom.search.value.trim()) runGrep();
        dom.search.focus();
      });
    }
    setSearchMode(searchMode);
  }

  // Wrap [start, end) character ranges of an element's text in <mark class="hit">,
  // across however many highlight spans the text is split into.
  function markTextRanges(root, ranges) {
    // Merge overlapping/duplicate ranges: wrapping the same text twice would
    // split a node at an offset it no longer has.
    const merged = [];
    for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0])) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    ranges = merged;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let offset = 0;
    for (let n; (n = walker.nextNode()); offset += n.data.length) nodes.push([n, offset]);
    for (const [node, off] of nodes) {
      const len = node.data.length;
      const local = ranges
        .map(([s, e]) => [Math.max(s - off, 0), Math.min(e - off, len)])
        .filter(([s, e]) => s < e)
        .sort((a, b) => b[0] - a[0]); // right to left keeps earlier offsets valid
      for (const [s, e] of local) {
        const hit = node.splitText(s);
        hit.splitText(e - s);
        const mark = el("mark", { class: "hit" });
        hit.replaceWith(mark);
        mark.append(hit);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Directory picker
  // ---------------------------------------------------------------------------

  const picker = { path: null, parent: null, token: 0 };

  async function pickerNavigate(path) {
    const token = ++picker.token;
    const list = $("#picker-list");
    list.replaceChildren(el("li", { class: "muted" }, "Loading…"));
    try {
      const data = await api("/api/list", { path, hidden: $("#picker-hidden").checked ? 1 : 0 });
      if (token !== picker.token) return;
      picker.path = data.path;
      picker.parent = data.parent;
      $("#picker-input").value = data.path;
      $("#picker-up").disabled = !data.parent;
      const dirs = data.entries.filter((e) => e.type === "dir");
      list.replaceChildren(
        ...dirs.map((d) =>
          el("li", {},
            el("button", { type: "button", dataset: { path: joinPath(data.path, d.name) } },
              svg(ICON.folder), el("span", {}, d.name))),
        ),
      );
      if (!dirs.length) list.append(el("li", { class: "muted" }, "No subdirectories"));
    } catch (e) {
      if (token !== picker.token) return;
      $("#picker-input").value = path;
      list.replaceChildren(el("li", { class: "muted error" }, e.message));
    }
  }

  function openPicker() {
    const quick = $("#picker-quick");
    const { home, root } = state.config;
    const places = [[root === "/" ? home : root, root === "/" ? "~ Home" : "Allowed root"]];
    if (root === "/") places.push(["/", "/"]);
    for (const p of store.get("recentRoots", [])) {
      if (!places.some(([q]) => q === p)) places.push([p, tildify(p)]);
    }
    quick.replaceChildren(
      ...places.map(([p, label]) =>
        el("button", { type: "button", class: "btn small", title: p, onclick: () => pickerNavigate(p) }, label)),
    );
    $("#picker-hidden").checked = settings.showHidden;
    pickerNavigate(state.root || (root === "/" ? home : root));
    dom.picker.showModal();
  }

  function initPicker() {
    $("#btn-open-dir").addEventListener("click", openPicker);
    $("#btn-empty-open").addEventListener("click", openPicker);
    $("#picker-list").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-path]");
      if (btn) pickerNavigate(btn.dataset.path);
    });
    $("#picker-up").addEventListener("click", () => picker.parent && pickerNavigate(picker.parent));
    $("#picker-go").addEventListener("click", () => pickerNavigate($("#picker-input").value.trim()));
    $("#picker-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        pickerNavigate(e.target.value.trim());
      }
    });
    $("#picker-hidden").addEventListener("change", () => picker.path && pickerNavigate(picker.path));
    $("#picker-select").addEventListener("click", async () => {
      if (!picker.path) return;
      dom.picker.close();
      await setRoot(picker.path);
    });
  }

  // ---------------------------------------------------------------------------
  // File type & language detection
  // ---------------------------------------------------------------------------

  const NAME_LANG = {
    dockerfile: "dockerfile", containerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile",
    "cmakelists.txt": "cmake", gemfile: "ruby", rakefile: "ruby", vagrantfile: "ruby", podfile: "ruby",
    brewfile: "ruby", jenkinsfile: "groovy", pkgbuild: "bash", apkbuild: "bash", ".bashrc": "bash",
    ".bash_profile": "bash", ".bash_aliases": "bash", ".bash_logout": "bash", ".profile": "bash", ".zshrc": "bash",
    ".zprofile": "bash", ".zshenv": "bash", ".zlogin": "bash", ".xinitrc": "bash", ".xprofile": "bash",
    ".gitconfig": "ini", ".editorconfig": "ini", ".npmrc": "ini", ".vimrc": "vim", ".gvimrc": "vim",
    ".htaccess": "apache", "nginx.conf": "nginx", ".gitattributes": "plaintext", "procfile": "yaml",
  };

  const EXT_LANG = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
    mts: "typescript", cts: "typescript", vue: "xml", svelte: "xml", astro: "xml", html: "xml", htm: "xml",
    xhtml: "xml", svg: "xml", xsd: "xml", xsl: "xml", xslt: "xml", plist: "xml", csproj: "xml", fsproj: "xml",
    vcxproj: "xml", xaml: "xml", kml: "xml", gpx: "xml", rss: "xml", atom: "xml", toml: "ini", cfg: "ini",
    conf: "ini", service: "ini", socket: "ini", timer: "ini", mount: "ini", desktop: "ini", env: "bash",
    sh: "bash", bash: "bash", zsh: "bash", ksh: "bash", fish: "bash", ps1: "powershell", psm1: "powershell",
    psd1: "powershell", h: "c", hpp: "cpp", hh: "cpp", hxx: "cpp", cc: "cpp", cxx: "cpp", ino: "cpp", cu: "cpp",
    cuh: "cpp", m: "objectivec", mm: "objectivec", kt: "kotlin", kts: "kotlin", rs: "rust", py: "python",
    pyw: "python", pyi: "python", pyx: "python", ipynb: "json", jsonc: "json", json5: "json", jsonl: "json",
    ndjson: "json", geojson: "json", webmanifest: "json", har: "json", sql: "sql", psql: "pgsql",
    graphql: "graphql", gql: "graphql", proto: "protobuf", tex: "latex", sty: "latex", cls: "latex",
    bib: "latex", r: "r", jl: "julia", ex: "elixir", exs: "elixir", heex: "elixir", erl: "erlang",
    hrl: "erlang", hs: "haskell", lhs: "haskell", ml: "ocaml", mli: "ocaml", fs: "fsharp", fsi: "fsharp",
    fsx: "fsharp", clj: "clojure", cljs: "clojure", cljc: "clojure", edn: "clojure", scm: "scheme",
    ss: "scheme", rkt: "scheme", el: "lisp", lisp: "lisp", lsp: "lisp", lua: "lua", pl: "perl", pm: "perl",
    t: "perl", rb: "ruby", gemspec: "ruby", rake: "ruby", php: "php", phtml: "php", swift: "swift",
    dart: "dart", scala: "scala", sc: "scala", sbt: "scala", groovy: "groovy", gradle: "gradle",
    vb: "vbnet", cs: "csharp", csx: "csharp", diff: "diff", patch: "diff", md: "markdown",
    markdown: "markdown", mdx: "markdown", mkd: "markdown", txt: "plaintext", text: "plaintext",
    log: "plaintext", ini: "ini", yml: "yaml", yaml: "yaml", nix: "nix", v: "verilog", sv: "verilog",
    svh: "verilog", vhd: "vhdl", vhdl: "vhdl", asm: "x86asm", nasm: "x86asm", s: "armasm", glsl: "glsl",
    vert: "glsl", frag: "glsl", geom: "glsl", comp: "glsl", cr: "crystal", nim: "nim", nims: "nim", d: "d",
    coffee: "coffeescript", ls: "livescript", hbs: "handlebars", handlebars: "handlebars",
    mustache: "handlebars", j2: "django", jinja: "django", jinja2: "django", twig: "twig", erb: "erb",
    haml: "haml", re: "reasonml", rei: "reasonml", ll: "llvm", st: "smalltalk", gcode: "gcode", nc: "gcode",
    bat: "dos", cmd: "dos", awk: "awk", tcl: "tcl", pas: "delphi", dpr: "delphi", f: "fortran",
    f90: "fortran", f95: "fortran", f03: "fortran", for: "fortran", mat: "matlab", elm: "elm",
    mk: "makefile", mak: "makefile", cmake: "cmake", dockerfile: "dockerfile", vim: "vim",
    properties: "properties", go: "go", java: "java", c: "c", cpp: "cpp", css: "css", scss: "scss",
    sass: "scss", less: "less", styl: "stylus", xml: "xml", json: "json", pro: "prolog",
    csv: "plaintext", tsv: "plaintext", tf: "ini", hcl: "ini", lock: "plaintext", sum: "plaintext",
    gitignore: "bash", dockerignore: "bash", npmignore: "bash", rst: "plaintext", adoc: "asciidoc",
  };

  const SHEBANG_LANG = {
    python: "python", python3: "python", bash: "bash", sh: "bash", zsh: "bash", dash: "bash", fish: "bash",
    node: "javascript", deno: "typescript", bun: "javascript", ruby: "ruby", perl: "perl", php: "php",
    lua: "lua", Rscript: "r", awk: "awk", tclsh: "tcl", pwsh: "powershell",
  };

  const extOf = (name) => {
    const i = name.lastIndexOf(".");
    return i > 0 || (i === 0 && !name.slice(1).includes(".")) ? name.slice(i + 1).toLowerCase() : "";
  };

  function detectLanguage(name, content) {
    const lower = name.toLowerCase();
    if (NAME_LANG[lower]) return NAME_LANG[lower];
    if (lower.startsWith(".env")) return "bash";
    if (lower.startsWith("dockerfile")) return "dockerfile";
    if (lower.endsWith("rc") && lower.startsWith(".")) {
      const body = content.trimStart();
      if (body.startsWith("{")) return "json";
    }
    const ext = extOf(lower);
    let lang = EXT_LANG[ext];
    if (!lang && ext && hljs.getLanguage(ext)) lang = ext;
    if (!lang || lang === "plaintext") {
      const m = content.match(/^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?([\w.+-]+)/);
      if (m) {
        const interp = m[1].replace(/[\d.]+$/, "");
        lang = SHEBANG_LANG[m[1]] || SHEBANG_LANG[interp] || lang;
      }
    }
    return lang && (lang === "plaintext" || hljs.getLanguage(lang)) ? lang : "plaintext";
  }

  // What the right panel should do with a file.
  function fileType(data) {
    if (data.kind !== "text") return data.kind; // image, pdf, binary, special
    const ext = extOf(data.name);
    if (["md", "markdown", "mdx", "mkd", "mdown"].includes(ext)) return "markdown";
    if (["html", "htm", "xhtml"].includes(ext)) return "html";
    if (ext === "csv" || ext === "tsv") return "csv";
    if (ext === "json") return "json";
    return "code";
  }

  // ---------------------------------------------------------------------------
  // Rendering helpers
  // ---------------------------------------------------------------------------

  const HIGHLIGHT_LIMIT = 2 * 1024 * 1024;

  function highlight(text, lang) {
    if (lang && lang !== "plaintext" && text.length <= HIGHLIGHT_LIMIT && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
      } catch { /* fall through */ }
    }
    return escapeHtml(text);
  }

  // Split highlighted HTML into lines, closing and reopening spans that cross
  // line boundaries so every line is self-contained markup.
  function splitLines(markup) {
    const lines = [];
    const stack = [];
    let cur = "";
    let last = 0;
    const re = /(<span[^>]*>)|(<\/span>)|(\r?\n)/g;
    let m;
    while ((m = re.exec(markup))) {
      cur += markup.slice(last, m.index);
      last = re.lastIndex;
      if (m[1]) {
        stack.push(m[1]);
        cur += m[1];
      } else if (m[2]) {
        stack.pop();
        cur += m[2];
      } else {
        lines.push(cur + "</span>".repeat(stack.length));
        cur = stack.join("");
      }
    }
    cur += markup.slice(last);
    lines.push(cur);
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  function codeBlock(text, lang) {
    const lines = splitLines(highlight(text, lang));
    const pre = el("pre", { class: `code hljs language-${lang}` });
    pre.style.setProperty("--gutter", String(lines.length).length + "ch");
    pre.innerHTML = lines.map((l) => `<span class="line">${l}\n</span>`).join("");
    return pre;
  }

  const slugify = (s) =>
    s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s+/g, "-");

  const isExternal = (href) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");

  // Lex Markdown and put an empty marker before each top-level block that
  // records the source line the block starts on. marked's tokens carry no
  // positions, but each keeps its raw source text, which we locate in order.
  function lexWithLineMarkers(text, firstLine) {
    const src = text.replace(/\r\n?/g, "\n");
    const tokens = marked.lexer(src, { gfm: true });
    const out = [];
    let pos = 0;
    let line = firstLine;
    for (const t of tokens) {
      const at = t.raw ? src.indexOf(t.raw, pos) : -1;
      if (at !== -1) {
        for (let i = pos; i < at; i++) if (src.charCodeAt(i) === 10) line++;
        pos = at;
        if (t.type !== "space") {
          out.push({ type: "html", block: true, pre: false, raw: "", text: `<span data-md-line="${line}"></span>` });
        }
      }
      out.push(t);
    }
    out.links = tokens.links;
    return out;
  }

  function renderMarkdown(text, filePath) {
    let frontMatter = null;
    let firstLine = 1;
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
    if (fm) {
      frontMatter = fm[1];
      text = text.slice(fm[0].length);
      firstLine += fm[0].split("\n").length - 1;
    }
    const html = marked.parser(lexWithLineMarkers(text, firstLine), { gfm: true });
    const article = el("article", { class: "markdown" });
    article.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ["style"] });
    // Move each line marker onto the block that follows it (data-line).
    for (const marker of article.querySelectorAll(":scope > span[data-md-line]")) {
      const next = marker.nextElementSibling;
      if (next && !next.matches("span[data-md-line]") && !next.dataset.line) next.dataset.line = marker.dataset.mdLine;
      marker.remove();
    }

    if (frontMatter !== null) {
      const pre = el("pre", { class: "front-matter" });
      const code = el("code", { class: "hljs language-yaml" });
      code.innerHTML = highlight(frontMatter, "yaml");
      pre.append(code);
      pre.dataset.line = "1";
      article.prepend(pre);
    }

    for (const code of article.querySelectorAll("pre code")) {
      const lang = (code.className.match(/language-([\w+#.-]+)/) || [])[1]?.toLowerCase();
      const resolved = lang && (hljs.getLanguage(lang) ? lang : EXT_LANG[lang]);
      if (resolved && resolved !== "plaintext") code.innerHTML = highlight(code.textContent, resolved);
      code.classList.add("hljs");
    }

    const seen = new Map();
    for (const h of article.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
      let id = h.id || slugify(h.textContent) || "section";
      const n = seen.get(id) || 0;
      seen.set(id, n + 1);
      if (n) id += "-" + n;
      h.id = id;
      h.append(el("a", { class: "heading-anchor", href: "#" + id, "aria-hidden": "true" }, "#"));
    }

    const dir = dirname(filePath);
    for (const img of article.querySelectorAll("img[src]")) {
      const src = img.getAttribute("src");
      if (!isExternal(src)) img.src = rawUrl(normalize(src.startsWith("/") ? src : dir + "/" + src));
      img.loading = "lazy";
    }
    for (const a of article.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (href.startsWith("#")) {
        a.dataset.anchor = decodeURIComponent(href.slice(1));
      } else if (isExternal(href)) {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      } else {
        const [pathPart, hash = ""] = href.split("#");
        let target = decodeURIComponent(pathPart.split("?")[0]);
        target = normalize(target.startsWith("/") ? target : dir + "/" + target);
        a.dataset.local = target;
        a.dataset.hash = hash;
        a.href = appUrl(target);
      }
    }
    return article;
  }

  const appUrl = (file) => `?${new URLSearchParams({ root: state.root, file })}`;

  function parseDelimited(text, delim, limit) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += c;
      } else if (c === '"' && field === "") quoted = true;
      else if (c === delim) { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        rows.push(row); row = [];
        if (rows.length > limit) return { rows, more: true };
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return { rows, more: false };
  }

  function renderCsv(text, delim) {
    const LIMIT = 5000;
    const { rows, more } = parseDelimited(text, delim, LIMIT);
    const wrap = el("div", { class: "table-wrap" });
    if (more) wrap.append(el("div", { class: "notice" }, `Showing the first ${LIMIT} rows. Switch to Source to see everything.`));
    const table = el("table", { class: "csv" });
    const [head = [], ...body] = rows;
    table.append(el("thead", {}, el("tr", {}, el("th", { class: "rn" }), ...head.map((h) => el("th", {}, h)))));
    const tbody = el("tbody");
    body.forEach((r, i) => tbody.append(el("tr", {}, el("td", { class: "rn" }, String(i + 1)), ...r.map((c) => el("td", {}, c)))));
    table.append(tbody);
    wrap.append(table);
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Viewer
  // ---------------------------------------------------------------------------

  function showError(message) {
    dom.viewer.classList.remove("fill");
    dom.viewer.replaceChildren(el("div", { class: "notice error" }, message));
  }

  function clearViewer() {
    state.file = null;
    state.data = null;
    dom.viewerHead.hidden = true;
    dom.viewer.classList.remove("fill");
    dom.viewer.replaceChildren(
      el("div", { class: "empty" },
        el("p", {}, state.root ? "Select a file from the tree to view it." : "Choose a directory to start browsing."),
        state.root ? null : el("button", { class: "btn primary", onclick: openPicker }, "Choose directory")),
    );
    document.title = "File Reader";
    markActive();
    schedulePoll();
  }

  async function openFile(path, { push = true, keepScroll = false, line = null, marks = null } = {}) {
    const sameFile = path === state.file;
    if (!keepScroll) {
      state.line = line;
      state.lineMarks = marks;
    }
    // Another line of the file that's already open: no need to refetch.
    if (sameFile && state.data && line && !keepScroll) {
      writeUrl(push);
      if (mobile.matches) closeDrawer();
      if (preferSource()) renderFile();
      else revealLine();
      return;
    }
    const token = ++state.loadToken;
    const scroll = keepScroll ? captureScroll() : null;
    state.file = path;
    if (!sameFile) {
      state.jsonPretty = false;
      state.view = "rendered";
    }
    writeUrl(push && !sameFile);
    markActive();
    if (mobile.matches) closeDrawer();

    const slow = setTimeout(() => {
      if (token === state.loadToken && !keepScroll) dom.viewer.replaceChildren(el("div", { class: "loading" }, "Loading…"));
    }, 150);
    let data;
    try {
      data = await api("/api/file", { path });
    } catch (e) {
      clearTimeout(slow);
      if (token !== state.loadToken) return;
      if (e.message === "is a directory") {
        state.file = null;
        writeUrl(false);
        clearViewer();
        if (isInside(path, state.root)) revealPath(path, true).then(openDrawer);
        else setRoot(path);
        return;
      }
      state.data = null;
      dom.viewerHead.hidden = true;
      showError(`${path}: ${e.message}`);
      return;
    }
    clearTimeout(slow);
    if (token !== state.loadToken) return;
    state.data = data;
    if (state.line) preferSource();
    renderFile();
    if (scroll) restoreScroll(scroll);
    if (!sameFile) revealPath(path, false);
    schedulePoll();
  }

  function captureScroll() {
    const frame = dom.viewer.querySelector("iframe");
    let frameScroll = null;
    try { frameScroll = frame && [frame.contentWindow.scrollX, frame.contentWindow.scrollY]; } catch { /* cross-origin */ }
    return { top: dom.viewer.scrollTop, left: dom.viewer.scrollLeft, frameScroll };
  }

  function restoreScroll({ top, left }) {
    dom.viewer.scrollTop = top;
    dom.viewer.scrollLeft = left;
  }

  function renderHeader(data, type) {
    // Breadcrumbs relative to the root.
    const crumbs = [];
    const root = state.root && isInside(data.path, state.root) ? state.root : "/";
    const rel = root === "/" ? data.path.slice(1) : data.path.slice(root.length + 1);
    const parts = rel.split("/");
    const rootName = root === "/" ? "/" : basename(root);
    crumbs.push(el("a", { title: root, onclick: () => revealPath(root, true).then(openDrawer) }, rootName));
    let cur = root;
    parts.forEach((part, i) => {
      cur = joinPath(cur, part);
      if (!(root === "/" && i === 0)) crumbs.push(el("span", { class: "sep" }, "/"));
      if (i === parts.length - 1) crumbs.push(el("span", { class: "current" }, part));
      else {
        const target = cur;
        crumbs.push(el("a", { title: target, onclick: () => revealPath(target, true).then(openDrawer) }, part));
      }
    });
    dom.crumbs.replaceChildren(...crumbs);

    const metaBits = [formatSize(data.size), new Date(data.mtime * 1000).toLocaleString()];
    if (data.encoding && data.encoding !== "utf-8") metaBits.push(data.encoding);
    if (type === "code" || type === "json") metaBits.push(detectLanguage(data.name, data.content || ""));
    dom.meta.textContent = metaBits.join(" · ");
    dom.meta.title = metaBits.join("\n");

    const actions = [];
    const toggleable = type === "markdown" || type === "html" || type === "csv" || (type === "image" && data.content);
    if (toggleable) {
      const seg = el("div", { class: "seg", role: "group" });
      for (const [view, label] of [["rendered", type === "image" ? "Image" : "Rendered"], ["source", "Source"]]) {
        seg.append(el("button", {
          type: "button",
          class: state.view === view ? "on" : "",
          onclick: () => {
            state.view = view;
            // An explicit view choice wins over "jump to line" (which prefers source).
            state.line = state.lineMarks = null;
            writeUrl(false);
            renderFile();
          },
        }, label));
      }
      actions.push(seg);
    }
    if (type === "json" && state.data.prettyCandidate) {
      actions.push(el("button", {
        type: "button",
        class: "btn small" + (state.jsonPretty ? " on" : ""),
        title: "Pretty-print JSON (display only)",
        onclick: () => { state.jsonPretty = !state.jsonPretty; renderFile(); },
      }, "Format"));
    }
    actions.push(el("button", {
      type: "button", class: "btn small", title: "Reload file",
      onclick: () => openFile(data.path, { push: false, keepScroll: true }),
    }, "Reload"));
    actions.push(el("button", {
      type: "button", class: "btn small", title: "Copy full path",
      onclick: async (e) => {
        const b = e.currentTarget;
        b.textContent = (await copyText(data.path)) ? "Copied" : "Copy failed";
        setTimeout(() => (b.textContent = "Copy path"), 1200);
      },
    }, "Copy path"));
    actions.push(el("a", {
      class: "btn small", href: rawUrl(data.path), target: "_blank", rel: "noopener",
      title: "Open the raw file in a new tab", style: "text-decoration:none",
    }, "Raw"));
    dom.actions.replaceChildren(...actions);
    dom.viewerHead.hidden = false;
  }

  function renderFile() {
    const data = state.data;
    if (!data) return;
    const type = fileType(data);
    if (type === "json" && data.prettyCandidate === undefined) {
      data.prettyCandidate = false;
      if (data.content.length < 5 * 1024 * 1024 && !data.truncated) {
        try { data.parsed = JSON.parse(data.content); data.prettyCandidate = true; } catch { /* not valid JSON */ }
      }
    }
    document.title = `${data.name} — File Reader`;
    renderHeader(data, type);

    const nodes = [];
    if (data.truncated) {
      nodes.push(el("div", { class: "notice" },
        `Large file: showing the first ${formatSize(state.config.maxBytes)} of ${formatSize(data.size)}.`));
    }
    let fill = false;
    const version = Math.round(data.mtime * 1000);
    const source = () => codeBlock(data.content, detectLanguage(data.name, data.content));

    switch (type) {
      case "markdown":
        nodes.push(state.view === "source" ? codeBlock(data.content, "markdown") : renderMarkdown(data.content, data.path));
        break;
      case "html":
        if (state.view === "source") nodes.push(codeBlock(data.content, "xml"));
        else {
          fill = true;
          const sandbox = "allow-popups allow-popups-to-escape-sandbox" + (settings.htmlScripts ? " allow-scripts" : "");
          nodes.push(el("iframe", { class: "frame", sandbox, src: rawUrl(data.path, version), title: data.name }));
        }
        break;
      case "csv":
        nodes.push(state.view === "source" ? source()
          : renderCsv(data.content, extOf(data.name) === "tsv" ? "\t" : ","));
        break;
      case "json":
        nodes.push(state.jsonPretty && data.prettyCandidate
          ? codeBlock(JSON.stringify(data.parsed, null, 2), "json") : source());
        break;
      case "code":
        nodes.push(source());
        break;
      case "image":
        if (data.content && state.view === "source") nodes.push(codeBlock(data.content, "xml"));
        else {
          const img = el("img", { src: rawUrl(data.path, version), alt: data.name, title: "Click to toggle actual size" });
          img.addEventListener("click", () => img.classList.toggle("actual"));
          img.addEventListener("load", () => {
            dom.meta.textContent += ` · ${img.naturalWidth}×${img.naturalHeight}`;
          }, { once: true });
          nodes.push(el("div", { class: "image-wrap" }, img));
        }
        break;
      case "pdf":
        fill = true;
        nodes.push(el("iframe", { class: "frame", src: rawUrl(data.path, version), title: data.name }));
        break;
      case "binary":
        nodes.push(el("div", { class: "empty" },
          el("p", {}, `Binary file${data.mime ? ` (${data.mime})` : ""} — not shown as text.`),
          el("a", { class: "btn", href: rawUrl(data.path), target: "_blank", rel: "noopener", style: "text-decoration:none" }, "Open raw")));
        break;
      default:
        nodes.push(el("div", { class: "empty" }, el("p", {}, "This is not a regular file (device, socket or pipe).")));
    }
    dom.viewer.classList.toggle("fill", fill);
    dom.viewer.replaceChildren(...nodes);
    if (!fill) {
      dom.viewer.scrollTop = 0;
      dom.viewer.scrollLeft = 0;
    }
    if (state.pendingAnchor) {
      scrollToAnchor(state.pendingAnchor);
      state.pendingAnchor = null;
    }
    if (state.line) revealLine();
  }

  // Line numbers refer to the file's source, so rendered views that can't be
  // mapped back to lines (HTML, CSV, SVG, formatted JSON) switch to source.
  // Rendered Markdown can: see revealMarkdownLine. Returns true if changed.
  function preferSource() {
    let changed = false;
    if (["html", "csv", "image"].includes(fileType(state.data)) && state.view !== "source") {
      state.view = "source";
      changed = true;
    }
    if (state.jsonPretty) {
      state.jsonPretty = false;
      changed = true;
    }
    return changed;
  }

  function revealLine() {
    if (dom.viewer.querySelector("article.markdown")) return revealMarkdownLine();
    const pre = dom.viewer.querySelector("pre.code");
    const lineEl = pre?.children[state.line - 1];
    if (!lineEl) return;
    pre.querySelector(".line.target")?.classList.remove("target");
    for (const m of pre.querySelectorAll("mark.hit")) m.replaceWith(...m.childNodes);
    lineEl.classList.add("target");
    if (state.lineMarks) markTextRanges(lineEl, state.lineMarks);
    lineEl.scrollIntoView({ block: "center" });
  }

  // Rendered Markdown has no line numbers. Find the block whose source starts
  // at or before the line, then the matched text within it: the n-th
  // occurrence in the source block maps to the n-th occurrence in its rendered
  // text. Approximate when markup hides some (e.g. text inside a link URL);
  // a match with no visible counterpart just isn't highlighted.
  function revealMarkdownLine() {
    const article = dom.viewer.querySelector("article.markdown");
    let block = null;
    for (const b of article.querySelectorAll(":scope > [data-line]")) {
      if (Number(b.dataset.line) > state.line) break;
      block = b;
    }
    if (!block) return;
    article.querySelector(".md-target")?.classList.remove("md-target");
    for (const m of article.querySelectorAll("mark.hit")) m.replaceWith(...m.childNodes);
    block.classList.add("md-target");

    const lines = state.data.content.split("\n");
    const srcLine = (lines[state.line - 1] ?? "").replace(/\r$/, "");
    const blockSrc = lines.slice(Number(block.dataset.line) - 1, state.line - 1).join("\n");
    const rendered = block.textContent;
    const count = (hay, needle) => {
      let n = 0;
      for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
      return n;
    };
    const ranges = [];
    for (const [s, e] of state.lineMarks || []) {
      const needle = srcLine.slice(s, e);
      if (!needle) continue;
      const nth = count(blockSrc + "\n" + srcLine.slice(0, s), needle);
      let at = rendered.indexOf(needle);
      for (let i = 0; i < nth && at !== -1; i++) at = rendered.indexOf(needle, at + needle.length);
      if (at !== -1) ranges.push([at, at + needle.length]);
    }
    if (ranges.length) markTextRanges(block, ranges);

    // Narrow the highlight from a whole list/table to the item or row: the one
    // holding the first match, or (for a bare &line= link with no match info)
    // the innermost one containing the line's text minus Markdown syntax.
    const first = block.querySelector("mark.hit");
    let target = first?.closest("li, tr");
    if (!target && !ranges.length) {
      const plain = srcLine
        .replace(/^\s*(?:>\s*)*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?/, "")
        .replace(/\]\([^)]*\)|[*_~`[\]|]/g, "")
        .trim()
        .slice(0, 40);
      if (plain) target = [...block.querySelectorAll("li, tr")].filter((e) => e.textContent.includes(plain)).pop();
    }
    if (target) {
      block.classList.remove("md-target");
      target.classList.add("md-target");
    }
    (first || target || block).scrollIntoView({ block: "center" });
  }

  function scrollToAnchor(id) {
    const target = dom.viewer.querySelector(`[id="${CSS.escape(id)}"]`) ||
      dom.viewer.querySelector(`[id="${CSS.escape(slugify(id))}"]`);
    target?.scrollIntoView({ block: "start" });
  }

  function initViewer() {
    dom.viewer.addEventListener("click", (e) => {
      const a = e.target.closest("a");
      if (!a || e.defaultPrevented) return;
      if (a.dataset.anchor !== undefined) {
        e.preventDefault();
        scrollToAnchor(a.dataset.anchor);
      } else if (a.dataset.local && !(e.ctrlKey || e.metaKey || e.shiftKey || e.button)) {
        e.preventDefault();
        if (a.dataset.hash) state.pendingAnchor = decodeURIComponent(a.dataset.hash);
        if (a.dataset.local === state.file && state.pendingAnchor) {
          scrollToAnchor(state.pendingAnchor);
          state.pendingAnchor = null;
        } else {
          openFile(a.dataset.local);
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Auto-refresh: poll the open file's mtime/size
  // ---------------------------------------------------------------------------

  function schedulePoll() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    if (!settings.autoRefresh || !state.file) return;
    state.pollTimer = setInterval(async () => {
      if (document.hidden || !state.data) return;
      const { path, mtime, size } = state.data;
      try {
        const st = await api("/api/stat", { path });
        if (path === state.file && (st.mtime !== mtime || st.size !== size)) {
          openFile(path, { push: false, keepScroll: true });
        }
      } catch { /* file may be mid-write or gone; try again next tick */ }
    }, 2000);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  async function init() {
    marked.use({ gfm: true });
    initSettings();
    initLayout();
    initTree();
    initSearch();
    initGrep();
    initPicker();
    initViewer();
    try {
      state.config = await api("/api/config");
    } catch (e) {
      showError("Could not reach the server: " + e.message);
      return;
    }
    window.addEventListener("popstate", applyUrl);
    await applyUrl();
  }

  init();
})();
