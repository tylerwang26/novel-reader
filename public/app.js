const DEFAULT_TOC =
  "https://big5.quanben5.com/amp/n/fanrenxiuxianchuan/xiaoshuo.html";

const STORAGE_KEY = "mosheng.library.v1";
const MAX_BOOKS = 24;

const state = {
  book: null,
  chapterIndex: 0,
  chapter: null,
  paragraphs: [],
  speakFrom: 0,
  speaking: false,
  paused: false,
  rate: 1,
  voice: null,
  recognition: null,
  listening: false,
  suppressResumePrompt: false,
};

const el = {
  tocForm: document.getElementById("toc-form"),
  tocUrl: document.getElementById("toc-url"),
  status: document.getElementById("status"),
  setup: document.getElementById("setup-panel"),
  reader: document.getElementById("reader"),
  bookTitle: document.getElementById("book-title"),
  chapterTitle: document.getElementById("chapter-title"),
  progressLine: document.getElementById("progress-line"),
  content: document.getElementById("content"),
  list: document.getElementById("chapter-list"),
  drawer: document.getElementById("drawer"),
  backdrop: document.getElementById("drawer-backdrop"),
  rate: document.getElementById("rate"),
  rateLabel: document.getElementById("rate-label"),
  searchForm: document.getElementById("search-form"),
  searchQ: document.getElementById("search-q"),
  searchRead: document.getElementById("search-read"),
  cmdForm: document.getElementById("cmd-form"),
  cmdInput: document.getElementById("cmd-input"),
  libraryList: document.getElementById("library-list"),
  libraryEmpty: document.getElementById("library-empty"),
  continueBanner: document.getElementById("continue-banner"),
  resumeBanner: document.getElementById("resume-banner"),
};

function setStatus(msg) {
  el.status.textContent = msg || "";
}

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------------- memory (localStorage) ---------------- */

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { books: [], lastSourceUrl: "" };
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.books)) return { books: [], lastSourceUrl: "" };
    return data;
  } catch {
    return { books: [], lastSourceUrl: "" };
  }
}

function saveStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (err) {
    console.warn("localStorage save failed", err);
  }
}

function bookKey(sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    u.hash = "";
    return u.href;
  } catch {
    return String(sourceUrl || "").trim();
  }
}

function getBooks() {
  return loadStore().books.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getBookRecord(sourceUrl) {
  const key = bookKey(sourceUrl);
  return getBooks().find((b) => bookKey(b.sourceUrl) === key) || null;
}

function upsertBook( partial ) {
  const store = loadStore();
  const key = bookKey(partial.sourceUrl);
  if (!key) return null;
  const idx = store.books.findIndex((b) => bookKey(b.sourceUrl) === key);
  const prev = idx >= 0 ? store.books[idx] : {};
  const next = {
    ...prev,
    ...partial,
    sourceUrl: key,
    title: partial.title || prev.title || "未命名小說",
    author: partial.author != null ? partial.author : prev.author || "",
    updatedAt: Date.now(),
    progress: {
      ...(prev.progress || {}),
      ...(partial.progress || {}),
    },
  };
  if (!next.progress.chapterTitle && next.progress.chapterIndex == null) {
    // keep empty progress object only if we intentionally set fields
  }
  if (idx >= 0) store.books[idx] = next;
  else store.books.unshift(next);
  store.books.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  store.books = store.books.slice(0, MAX_BOOKS);
  store.lastSourceUrl = key;
  saveStore(store);
  return next;
}

function removeBook(sourceUrl) {
  const store = loadStore();
  const key = bookKey(sourceUrl);
  store.books = store.books.filter((b) => bookKey(b.sourceUrl) !== key);
  if (store.lastSourceUrl === key) {
    store.lastSourceUrl = store.books[0] ? store.books[0].sourceUrl : "";
  }
  saveStore(store);
}

function saveProgress(extra = {}) {
  if (!state.book?.sourceUrl) return;
  const ch = state.book.chapters?.[state.chapterIndex];
  const chapterTitle =
    (state.chapter && state.chapter.title) || (ch && ch.title) || "";
  upsertBook({
    sourceUrl: state.book.sourceUrl,
    title: state.book.title,
    author: state.book.author || "",
    chapterCount: state.book.chapterCount,
    progress: {
      chapterIndex: state.chapterIndex,
      chapterTitle,
      chapterUrl: (state.chapter && state.chapter.url) || (ch && ch.url) || "",
      paragraphIndex: state.speakFrom || 0,
      rate: state.rate,
      ...extra,
    },
  });
  updateProgressLine();
  renderLibrary();
}

function formatProgress(rec) {
  if (!rec || !rec.progress) return "尚未開始朗讀";
  const p = rec.progress;
  const chap = p.chapterTitle || (p.chapterIndex != null ? `第 ${p.chapterIndex + 1} 章` : "未知章節");
  const para =
    p.paragraphIndex != null && p.paragraphIndex > 0
      ? ` · 第 ${p.paragraphIndex + 1} 段`
      : "";
  return `${chap}${para}`;
}

function updateProgressLine() {
  if (!el.progressLine) return;
  if (!state.book) {
    el.progressLine.textContent = "";
    return;
  }
  const rec = getBookRecord(state.book.sourceUrl);
  el.progressLine.textContent = rec
    ? `進度：${formatProgress(rec)}（已記住）`
    : "進度：尚未儲存";
}

function renderLibrary() {
  const books = getBooks();
  if (!el.libraryList) return;
  el.libraryList.innerHTML = "";
  el.libraryEmpty.hidden = books.length > 0;

  // home continue banner: most recently updated with progress
  const withProgress = books.find(
    (b) => b.progress && (b.progress.chapterIndex != null || b.progress.chapterUrl),
  );
  if (withProgress && el.continueBanner) {
    el.continueBanner.hidden = false;
    el.continueBanner.innerHTML = "";
    const p = document.createElement("p");
    p.innerHTML = `<strong>從上次繼續</strong> · ${escapeHtml(withProgress.title)} · ${escapeHtml(formatProgress(withProgress))}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "primary";
    btn.textContent = "繼續閱讀";
    btn.addEventListener("click", () =>
      openBook(withProgress.sourceUrl, { resume: true, autoplay: false }),
    );
    const btnSpeak = document.createElement("button");
    btnSpeak.type = "button";
    btnSpeak.className = "ghost";
    btnSpeak.textContent = "繼續唸";
    btnSpeak.addEventListener("click", () =>
      openBook(withProgress.sourceUrl, { resume: true, autoplay: true }),
    );
    el.continueBanner.append(p, btn, btnSpeak);
  } else if (el.continueBanner) {
    el.continueBanner.hidden = true;
    el.continueBanner.innerHTML = "";
  }

  books.forEach((rec) => {
    const li = document.createElement("li");
    li.className = "library-item";
    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("p");
    title.className = "title";
    title.textContent = rec.title || "未命名小說";
    const sub = document.createElement("p");
    sub.className = "sub";
    sub.textContent = `${rec.author ? rec.author + " · " : ""}${formatProgress(rec)}`;
    sub.title = rec.sourceUrl;
    meta.append(title, sub);

    const actions = document.createElement("div");
    actions.className = "actions";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "primary";
    openBtn.textContent = "開啟";
    openBtn.addEventListener("click", () =>
      openBook(rec.sourceUrl, { resume: true, autoplay: false }),
    );
    const contBtn = document.createElement("button");
    contBtn.type = "button";
    contBtn.className = "ghost";
    contBtn.textContent = "繼續唸";
    contBtn.addEventListener("click", () =>
      openBook(rec.sourceUrl, { resume: true, autoplay: true }),
    );
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "ghost danger";
    delBtn.textContent = "刪除";
    delBtn.addEventListener("click", () => {
      if (confirm(`刪除「${rec.title}」的網站與進度紀錄？`)) {
        removeBook(rec.sourceUrl);
        renderLibrary();
        setStatus("已刪除紀錄");
      }
    });
    actions.append(openBtn, contBtn, delBtn);
    li.append(meta, actions);
    el.libraryList.appendChild(li);
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showResumeBanner(rec) {
  if (!el.resumeBanner || !rec?.progress) {
    if (el.resumeBanner) {
      el.resumeBanner.hidden = true;
      el.resumeBanner.innerHTML = "";
    }
    return;
  }
  const p = rec.progress;
  const sameChapter = p.chapterIndex === state.chapterIndex;
  const para = p.paragraphIndex || 0;
  if (sameChapter && para <= 0 && !state.suppressResumePrompt) {
    // still show once when just opened
  }
  el.resumeBanner.hidden = false;
  el.resumeBanner.innerHTML = "";
  const text = document.createElement("p");
  text.innerHTML = `<strong>上次進度</strong> · ${escapeHtml(formatProgress(rec))}`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "primary";
  btn.textContent = "從上次繼續唸";
  btn.addEventListener("click", () => resumeFromSaved({ autoplay: true }));
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "ghost";
  dismiss.textContent = "稍後";
  dismiss.addEventListener("click", () => {
    el.resumeBanner.hidden = true;
  });
  el.resumeBanner.append(text, btn, dismiss);
}

/* ---------------- TTS / chapters ---------------- */

function chineseToNumber(raw) {
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const digits = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    兩: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (s === "十") return 10;
  if (s === "百") return 100;
  let n = 0;
  if (s.includes("百")) {
    const [a, b] = s.split("百");
    n += (digits[a] != null ? digits[a] : 1) * 100;
    if (b) n += chineseToNumber(b);
    return n;
  }
  if (s.includes("十")) {
    const [a, b] = s.split("十");
    const tens = a === "" ? 1 : digits[a] != null ? digits[a] : Number(a) || 0;
    n += tens * 10;
    if (b) n += digits[b] != null ? digits[b] : Number(b) || 0;
    return n;
  }
  if (s.length === 1 && digits[s] != null) return digits[s];
  return NaN;
}

function pickZhTwFemaleVoice() {
  const voices = speechSynthesis.getVoices() || [];
  const score = (v) => {
    let s = 0;
    const lang = (v.lang || "").toLowerCase();
    const name = (v.name || "").toLowerCase();
    if (lang === "zh-tw" || lang.startsWith("zh-tw")) s += 50;
    else if (lang.includes("hant") || lang.includes("taiwan")) s += 40;
    else if (lang.startsWith("zh")) s += 10;
    if (/female|woman|girl|meijia|hanhan|yating|hsiao|xiao|tingting|linlin|yaoyao/.test(name))
      s += 30;
    if (/male|man|boy|yunyang|yunjian|kangkang/.test(name)) s -= 25;
    if (/google|microsoft|apple|meijia|han.?han/.test(name)) s += 8;
    return s;
  };
  const ranked = [...voices].sort((a, b) => score(b) - score(a));
  state.voice = ranked[0] || null;
  return state.voice;
}

function ensureVoices() {
  pickZhTwFemaleVoice();
  if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = () => pickZhTwFemaleVoice();
  }
}

function stopSpeech() {
  speechSynthesis.cancel();
  state.speaking = false;
  state.paused = false;
  clearSpeakingClass();
}

function clearSpeakingClass() {
  el.content
    .querySelectorAll("p.speaking")
    .forEach((p) => p.classList.remove("speaking"));
}

function speakFrom(index = 0) {
  if (!("speechSynthesis" in window)) {
    setStatus("此瀏覽器不支援語音合成（Speech Synthesis）");
    return;
  }
  stopSpeech();
  state.speakFrom = Math.max(0, index);
  state.speaking = true;
  state.paused = false;
  pickZhTwFemaleVoice();
  saveProgress();
  speakNext();
}

function speakNext() {
  if (!state.speaking || state.paused) return;
  if (state.speakFrom >= state.paragraphs.length) {
    state.speaking = false;
    saveProgress({ paragraphIndex: 0 });
    setStatus("本章朗讀完畢");
    if (state.chapterIndex < (state.book?.chapters.length || 0) - 1) {
      setStatus("本章朗讀完畢，載入下一章…");
      loadChapter(state.chapterIndex + 1, { autoplay: true, paragraphIndex: 0 });
    }
    return;
  }
  const i = state.speakFrom;
  const text = state.paragraphs[i];
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "zh-TW";
  u.rate = state.rate;
  if (state.voice) u.voice = state.voice;
  clearSpeakingClass();
  const node = el.content.children[i];
  if (node) {
    node.classList.add("speaking");
    node.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  // persist as we start each paragraph
  saveProgress({ paragraphIndex: i });
  u.onend = () => {
    state.speakFrom = i + 1;
    saveProgress({ paragraphIndex: state.speakFrom });
    speakNext();
  };
  u.onerror = () => {
    state.speakFrom = i + 1;
    saveProgress({ paragraphIndex: state.speakFrom });
    speakNext();
  };
  speechSynthesis.speak(u);
}

function pauseSpeech() {
  if (!state.speaking) return;
  speechSynthesis.pause();
  state.paused = true;
  saveProgress();
  setStatus("已暫停（進度已記住）");
}

function resumeSpeech() {
  if (!state.speaking) {
    speakFrom(state.speakFrom || 0);
    return;
  }
  speechSynthesis.resume();
  state.paused = false;
  setStatus("繼續朗讀");
}

async function openBook(url, { resume = true, autoplay = false } = {}) {
  el.tocUrl.value = url;
  await loadToc(url, { resume, autoplay });
}

async function loadToc(url, { resume = true, autoplay = false } = {}) {
  setStatus("正在載入目錄…");
  let data;
  try {
    data = await api(`/api/toc?url=${encodeURIComponent(url)}`);
  } catch (err) {
    setStatus(`載入失敗：${err.message || err}`);
    throw err;
  }
  state.book = data;
  el.bookTitle.textContent = `${data.title}${data.author ? " · " + data.author : ""}`;
  upsertBook({
    sourceUrl: data.sourceUrl || url,
    title: data.title,
    author: data.author || "",
    chapterCount: data.chapterCount,
  });
  renderChapterList();
  renderLibrary();
  el.setup.hidden = true;
  el.reader.hidden = false;
  setStatus(`已載入 ${data.chapterCount} 章`);

  const rec = getBookRecord(data.sourceUrl || url);
  let startIndex = 0;
  let paragraphIndex = 0;
  if (resume && rec?.progress && rec.progress.chapterIndex != null) {
    startIndex = Math.min(
      Math.max(0, rec.progress.chapterIndex),
      Math.max(0, data.chapters.length - 1),
    );
    paragraphIndex = Math.max(0, rec.progress.paragraphIndex || 0);
    if (rec.progress.rate) {
      state.rate = Number(rec.progress.rate) || state.rate;
      el.rate.value = String(state.rate);
      el.rateLabel.textContent = `${state.rate.toFixed(1)}×`;
    }
  }

  if (data.chapters.length) {
    await loadChapter(startIndex, {
      autoplay,
      paragraphIndex: resume ? paragraphIndex : 0,
      showResumePrompt: resume && !autoplay,
    });
  }
}

function renderChapterList() {
  el.list.innerHTML = "";
  (state.book?.chapters || []).forEach((ch, i) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = ch.title;
    btn.className = i === state.chapterIndex ? "active" : "";
    btn.addEventListener("click", () => {
      closeDrawer();
      loadChapter(i, { autoplay: false, paragraphIndex: 0 });
    });
    li.appendChild(btn);
    el.list.appendChild(li);
  });
}

async function loadChapter(
  index,
  { autoplay = false, paragraphIndex = 0, showResumePrompt = false } = {},
) {
  const ch = state.book?.chapters?.[index];
  if (!ch) return;
  stopSpeech();
  setStatus(`載入：${ch.title}`);
  const data = await api(`/api/chapter?url=${encodeURIComponent(ch.url)}`);
  state.chapterIndex = index;
  state.chapter = data;
  state.paragraphs = data.paragraphs || [];
  const maxPara = Math.max(0, state.paragraphs.length - 1);
  state.speakFrom = Math.min(Math.max(0, paragraphIndex), maxPara);
  el.chapterTitle.textContent = data.title || ch.title;
  el.content.innerHTML = "";
  state.paragraphs.forEach((p) => {
    const node = document.createElement("p");
    node.textContent = p;
    el.content.appendChild(node);
  });
  renderChapterList();
  saveProgress({
    chapterIndex: index,
    chapterTitle: data.title || ch.title,
    chapterUrl: data.url || ch.url,
    paragraphIndex: state.speakFrom,
  });
  setStatus(`已就緒：${data.title || ch.title}`);

  const rec = getBookRecord(state.book.sourceUrl);
  if (showResumePrompt && rec?.progress) {
    showResumeBanner(rec);
  } else if (el.resumeBanner) {
    el.resumeBanner.hidden = true;
  }

  if (autoplay) {
    speakFrom(state.speakFrom);
  } else if (state.speakFrom > 0) {
    const node = el.content.children[state.speakFrom];
    if (node) node.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

async function resumeFromSaved({ autoplay = true } = {}) {
  if (!state.book) {
    const books = getBooks();
    const rec = books.find(
      (b) => b.progress && b.progress.chapterIndex != null,
    );
    if (!rec) {
      setStatus("沒有可繼續的進度");
      return;
    }
    await openBook(rec.sourceUrl, { resume: true, autoplay });
    return;
  }
  const rec = getBookRecord(state.book.sourceUrl);
  if (!rec?.progress) {
    setStatus("這本書還沒有進度，從頭朗讀");
    speakFrom(0);
    return;
  }
  const p = rec.progress;
  const idx =
    p.chapterIndex != null
      ? p.chapterIndex
      : state.book.chapters.findIndex((c) => c.url === p.chapterUrl);
  if (idx < 0) {
    setStatus("找不到上次章節，從頭朗讀");
    speakFrom(0);
    return;
  }
  if (idx !== state.chapterIndex) {
    await loadChapter(idx, {
      autoplay,
      paragraphIndex: p.paragraphIndex || 0,
    });
  } else if (autoplay) {
    speakFrom(p.paragraphIndex || 0);
  } else {
    state.speakFrom = p.paragraphIndex || 0;
    setStatus(`已定位到上次進度：${formatProgress(rec)}`);
  }
  if (el.resumeBanner) el.resumeBanner.hidden = true;
}

function openDrawer() {
  el.drawer.hidden = false;
  el.backdrop.hidden = false;
}

function closeDrawer() {
  el.drawer.hidden = true;
  el.backdrop.hidden = true;
}

function goHome() {
  stopSpeech();
  el.reader.hidden = true;
  el.setup.hidden = false;
  renderLibrary();
  setStatus("已回到書單。可繼續閱讀或載入新目錄。");
}

function findChapterByNumber(n) {
  if (!state.book) return -1;
  const byTitle = state.book.chapters.findIndex((c) => {
    const m = c.title.match(/第([零〇一二兩三四五六七八九十百千\d]+)章/);
    if (!m) return false;
    return chineseToNumber(m[1]) === n;
  });
  if (byTitle >= 0) return byTitle;
  if (n >= 1 && n <= state.book.chapters.length) return n - 1;
  return -1;
}

function runCommand(raw) {
  const text = String(raw || "").trim();
  if (!text) return;
  setStatus(`指令：${text}`);

  let m =
    text.match(/從第\s*([零〇一二兩三四五六七八九十百千\d]+)\s*章開始(?:唸|念|讀|朗讀)?/) ||
    text.match(/第\s*([零〇一二兩三四五六七八九十百千\d]+)\s*章開始(?:唸|念|讀|朗讀)?/) ||
    text.match(/(?:唸|念|讀|朗讀)\s*第\s*([零〇一二兩三四五六七八九十百千\d]+)\s*章/);
  if (m) {
    const n = chineseToNumber(m[1]);
    const idx = findChapterByNumber(n);
    if (idx < 0) {
      setStatus(`找不到第 ${m[1]} 章`);
      return;
    }
    loadChapter(idx, { autoplay: true, paragraphIndex: 0 });
    return;
  }

  if (/暫停|停一下|先停/.test(text)) {
    pauseSpeech();
    return;
  }
  // 「繼續唸／繼續朗讀／從上次繼續」優先接進度；單純「繼續」若正在播則 resume
  if (/繼續唸|繼續念|繼續朗讀|從上次繼續|接著唸|接著念/.test(text)) {
    resumeFromSaved({ autoplay: true });
    return;
  }
  if (/繼續|恢復|接著/.test(text)) {
    if (state.speaking || state.paused) resumeSpeech();
    else resumeFromSaved({ autoplay: true });
    return;
  }
  if (/下一章/.test(text)) {
    loadChapter(state.chapterIndex + 1, { autoplay: true, paragraphIndex: 0 });
    return;
  }
  if (/上一章/.test(text)) {
    loadChapter(Math.max(0, state.chapterIndex - 1), {
      autoplay: true,
      paragraphIndex: 0,
    });
    return;
  }
  if (/^(開始)?(朗讀|唸|念|讀)$/.test(text) || /開始朗讀|開始唸/.test(text)) {
    speakFrom(state.speakFrom || 0);
    return;
  }
  if (/停止|關掉語音/.test(text)) {
    stopSpeech();
    saveProgress();
    setStatus("已停止朗讀（進度已記住）");
    return;
  }
  if (/速度\s*([0-9.]+)/.test(text)) {
    const r = Number(text.match(/速度\s*([0-9.]+)/)[1]);
    if (r >= 0.5 && r <= 2) {
      state.rate = r;
      el.rate.value = String(r);
      el.rateLabel.textContent = `${r.toFixed(1)}×`;
      saveProgress({ rate: r });
      setStatus(`速度設為 ${r}×`);
    }
    return;
  }

  if (/搜尋|找/.test(text)) {
    const q = text.replace(/.*(?:搜尋|找)\s*/, "").trim();
    if (q) jumpToSearch(q, true);
    return;
  }

  setStatus(`無法辨識指令：「${text}」。可試「繼續唸」或「從第 3 章開始唸」`);
}

function jumpToSearch(q, thenRead) {
  const needle = q.trim();
  if (!needle) return;
  const idx = state.paragraphs.findIndex((p) => p.includes(needle));
  if (idx < 0) {
    setStatus(`本章找不到「${needle}」`);
    return;
  }
  el.content.querySelectorAll("p.hit").forEach((p) => p.classList.remove("hit"));
  const node = el.content.children[idx];
  if (node) {
    node.classList.add("hit");
    node.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  state.speakFrom = idx;
  saveProgress({ paragraphIndex: idx });
  setStatus(`已跳到第 ${idx + 1} 段`);
  if (thenRead) speakFrom(idx);
}

function setupRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = document.getElementById("btn-mic");
  if (!SR) {
    btn.title = "此瀏覽器不支援語音辨識，請用下方文字指令";
    btn.addEventListener("click", () => {
      el.cmdInput.focus();
      setStatus("無 Web Speech 辨識，請輸入文字指令");
    });
    return;
  }
  const rec = new SR();
  rec.lang = "zh-TW";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (ev) => {
    const said = ev.results?.[0]?.[0]?.transcript || "";
    el.cmdInput.value = said;
    runCommand(said);
  };
  rec.onerror = () => {
    state.listening = false;
    btn.classList.remove("primary");
    setStatus("語音辨識結束或失敗，可改用文字指令");
  };
  rec.onend = () => {
    state.listening = false;
    btn.classList.remove("primary");
  };
  state.recognition = rec;
  btn.addEventListener("click", () => {
    if (state.listening) {
      rec.stop();
      return;
    }
    try {
      rec.start();
      state.listening = true;
      btn.classList.add("primary");
      setStatus("正在聽…可說「繼續唸」或「從第 N 章開始唸」");
    } catch {
      setStatus("無法啟動麥克風，請改用文字指令");
    }
  });
}

function bindUi() {
  el.tocForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await loadToc(el.tocUrl.value.trim() || DEFAULT_TOC, {
        resume: true,
        autoplay: false,
      });
    } catch (err) {
      setStatus(String(err.message || err));
    }
  });

  document.getElementById("btn-chapters").addEventListener("click", openDrawer);
  document.getElementById("btn-close-drawer").addEventListener("click", closeDrawer);
  el.backdrop.addEventListener("click", closeDrawer);

  document.getElementById("btn-home").addEventListener("click", goHome);
  document.getElementById("btn-resume").addEventListener("click", () =>
    resumeFromSaved({ autoplay: true }),
  );

  document.getElementById("btn-play").addEventListener("click", () => {
    if (state.paused) resumeSpeech();
    else speakFrom(state.speakFrom || 0);
  });
  document.getElementById("btn-pause").addEventListener("click", () => {
    if (state.paused) resumeSpeech();
    else pauseSpeech();
  });
  document.getElementById("btn-prev").addEventListener("click", () => {
    loadChapter(Math.max(0, state.chapterIndex - 1), {
      autoplay: false,
      paragraphIndex: 0,
    });
  });
  document.getElementById("btn-next").addEventListener("click", () => {
    loadChapter(
      Math.min((state.book?.chapters.length || 1) - 1, state.chapterIndex + 1),
      { autoplay: false, paragraphIndex: 0 },
    );
  });

  el.rate.addEventListener("input", () => {
    state.rate = Number(el.rate.value);
    el.rateLabel.textContent = `${state.rate.toFixed(1)}×`;
    saveProgress({ rate: state.rate });
  });

  el.searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    jumpToSearch(el.searchQ.value, el.searchRead.checked);
  });

  el.cmdForm.addEventListener("submit", (e) => {
    e.preventDefault();
    runCommand(el.cmdInput.value);
  });

  window.addEventListener("beforeunload", () => {
    if (state.book) saveProgress();
  });
}

ensureVoices();
bindUi();
setupRecognition();
renderLibrary();

const store = loadStore();
if (store.lastSourceUrl) {
  el.tocUrl.value = store.lastSourceUrl;
}
setStatus(
  getBooks().length
    ? "就緒。可從「最近書單」繼續，或載入新目錄。"
    : "就緒。載入目錄後即可朗讀；網站與進度會自動記住。",
);
