const DEFAULT_TOC =
  "https://big5.quanben5.com/amp/n/fanrenxiuxianchuan/xiaoshuo.html";
const STORAGE_KEY = "mosheng.library.v2";
const SETTINGS_KEY = "mosheng.settings.v1";
const IDB_NAME = "mosheng-db";
const IDB_STORE = "kv";
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
  audioUnlocked: false,
  audioCtx: null,
  ttsToken: 0,
  currentAudio: null,
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
  settings: document.getElementById("settings"),
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
  btnToggle: document.getElementById("btn-toggle"),
  micHint: document.getElementById("mic-hint"),
  ttsEngine: document.getElementById("tts-engine"),
  openaiKey: document.getElementById("openai-key"),
  openaiVoice: document.getElementById("openai-voice"),
  syncCode: document.getElementById("sync-code"),
  unlockAudio: document.getElementById("unlock-audio"),
  ttsAudio: document.getElementById("tts-audio"),
};

function setStatus(msg) {
  if (el.status) el.status.textContent = msg || "";
}

function updateToggleLabel() {
  if (!el.btnToggle) return;
  if (state.speaking && !state.paused) el.btnToggle.textContent = "暫停";
  else if (state.speaking && state.paused) el.btnToggle.textContent = "繼續";
  else el.btnToggle.textContent = "朗讀";
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

/* ---------------- settings ---------------- */

function loadSettings() {
  try {
    return {
      ttsEngine: "auto",
      openaiKey: "",
      openaiVoice: "nova",
      syncCode: "",
      ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {}),
    };
  } catch {
    return { ttsEngine: "auto", openaiKey: "", openaiVoice: "nova", syncCode: "" };
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

function fillSettingsForm() {
  const s = loadSettings();
  el.ttsEngine.value = s.ttsEngine || "auto";
  el.openaiKey.value = s.openaiKey || "";
  el.openaiVoice.value = s.openaiVoice || "nova";
  el.syncCode.value = s.syncCode || "";
}

/* ---------------- persistence: localStorage + IndexedDB ---------------- */

function openIdb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return resolve(null);
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function idbGet(key) {
  const db = await openIdb();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

async function idbSet(key, value) {
  const db = await openIdb();
  if (!db) return false;
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

function loadStoreSync() {
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

async function loadStore() {
  const fromIdb = await idbGet(STORAGE_KEY);
  if (fromIdb && Array.isArray(fromIdb.books)) return fromIdb;
  return loadStoreSync();
}

async function saveStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (err) {
    console.warn("localStorage failed", err);
  }
  await idbSet(STORAGE_KEY, store);
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

function getBooksFrom(store) {
  return (store.books || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function getBooks() {
  return getBooksFrom(await loadStore());
}

async function getBookRecord(sourceUrl) {
  const key = bookKey(sourceUrl);
  return (await getBooks()).find((b) => bookKey(b.sourceUrl) === key) || null;
}

async function upsertBook(partial) {
  const store = await loadStore();
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
  if (idx >= 0) store.books[idx] = next;
  else store.books.unshift(next);
  store.books.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  store.books = store.books.slice(0, MAX_BOOKS);
  store.lastSourceUrl = key;
  await saveStore(store);
  return next;
}

async function removeBook(sourceUrl) {
  const store = await loadStore();
  const key = bookKey(sourceUrl);
  store.books = store.books.filter((b) => bookKey(b.sourceUrl) !== key);
  if (store.lastSourceUrl === key) {
    store.lastSourceUrl = store.books[0] ? store.books[0].sourceUrl : "";
  }
  await saveStore(store);
}

async function saveProgress(extra = {}) {
  if (!state.book?.sourceUrl) return;
  const ch = state.book.chapters?.[state.chapterIndex];
  const chapterTitle =
    (state.chapter && state.chapter.title) || (ch && ch.title) || "";
  await upsertBook({
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
  // debounce cloud sync if code exists
  scheduleCloudSync();
  await renderLibrary();
  writeProgressToUrl();
}

function formatProgress(rec) {
  if (!rec || !rec.progress) return "尚未開始朗讀";
  const p = rec.progress;
  const chap =
    p.chapterTitle ||
    (p.chapterIndex != null ? `第 ${p.chapterIndex + 1} 章` : "未知章節");
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
  getBookRecord(state.book.sourceUrl).then((rec) => {
    el.progressLine.textContent = rec
      ? `進度：${formatProgress(rec)}（已記住）`
      : "進度：尚未儲存";
  });
}

function writeProgressToUrl() {
  if (!state.book) return;
  try {
    const u = new URL(location.href);
    u.searchParams.set("book", state.book.sourceUrl);
    u.searchParams.set("c", String(state.chapterIndex));
    u.searchParams.set("p", String(state.speakFrom || 0));
    const code = loadSettings().syncCode;
    if (code) u.searchParams.set("sync", code);
    history.replaceState(null, "", u.toString());
  } catch {
    /* ignore */
  }
}

/* ---------------- cloud sync ---------------- */

let syncTimer = null;
function scheduleCloudSync() {
  const code = loadSettings().syncCode;
  if (!code) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    pushSync().catch(() => {});
  }, 1200);
}

async function pushSync() {
  const library = await loadStore();
  const settings = loadSettings();
  const data = await api("/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: settings.syncCode || undefined, library }),
  });
  if (data.code) {
    saveSettings({ syncCode: data.code });
    el.syncCode.value = data.code;
  }
  setStatus(`進度已上傳，同步碼：${data.code}`);
  return data.code;
}

async function pullSync(code) {
  const c = String(code || el.syncCode.value || "")
    .trim()
    .toUpperCase();
  if (!c) throw new Error("請先輸入同步碼");
  const data = await api(`/api/sync?code=${encodeURIComponent(c)}`);
  await saveStore(data.library);
  saveSettings({ syncCode: c });
  el.syncCode.value = c;
  await renderLibrary();
  setStatus(`已拉取同步碼 ${c} 的進度`);
  return data.library;
}

/* ---------------- audio unlock (mobile) ---------------- */

async function unlockAudio() {
  if (state.audioUnlocked) return true;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      state.audioCtx = state.audioCtx || new AC();
      if (state.audioCtx.state === "suspended") await state.audioCtx.resume();
      const buf = state.audioCtx.createBuffer(1, 1, 22050);
      const src = state.audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(state.audioCtx.destination);
      src.start(0);
    }
    // also poke HTMLAudioElement (iOS)
    const a = el.unlockAudio;
    if (a) {
      a.src =
        "data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA//////////////////////////////////////////////////////////////////8AAAA5TEFNRTMuMTAwAZYAAAAAAAAAABUgJAUHQQAB9gAAAnGPqZEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      a.volume = 0.01;
      try {
        await a.play();
        a.pause();
      } catch {
        /* ignore */
      }
    }
    // warm speechSynthesis on supporting browsers
    if ("speechSynthesis" in window) {
      speechSynthesis.cancel();
      const warm = new SpeechSynthesisUtterance(" ");
      warm.volume = 0;
      warm.rate = 1;
      speechSynthesis.speak(warm);
      speechSynthesis.cancel();
    }
    state.audioUnlocked = true;
    return true;
  } catch (err) {
    console.warn("unlockAudio", err);
    return false;
  }
}

/* ---------------- TTS engines ---------------- */

function useOpenAiTts() {
  const s = loadSettings();
  if (s.ttsEngine === "browser") return false;
  if (s.ttsEngine === "openai") return Boolean(s.openaiKey);
  return Boolean(s.openaiKey); // auto
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
    if (/female|woman|girl|meijia|hanhan|yating|hsiao|xiao|ting|yao/.test(name))
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
  if (!("speechSynthesis" in window)) return;
  pickZhTwFemaleVoice();
  speechSynthesis.onvoiceschanged = () => pickZhTwFemaleVoice();
}

function clearSpeakingClass() {
  el.content
    ?.querySelectorAll("p.speaking")
    .forEach((p) => p.classList.remove("speaking"));
}

function stopSpeech() {
  state.ttsToken += 1;
  try {
    speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
  if (el.ttsAudio) {
    try {
      el.ttsAudio.pause();
      el.ttsAudio.removeAttribute("src");
      el.ttsAudio.load();
    } catch {
      /* ignore */
    }
  }
  if (state.currentAudio) {
    try {
      state.currentAudio.pause();
    } catch {
      /* ignore */
    }
    state.currentAudio = null;
  }
  state.speaking = false;
  state.paused = false;
  clearSpeakingClass();
  updateToggleLabel();
}

async function speakFrom(index = 0) {
  await unlockAudio();
  if (!state.paragraphs.length) {
    setStatus("沒有可朗讀的正文");
    return;
  }
  stopSpeech();
  state.speakFrom = Math.max(0, index);
  state.speaking = true;
  state.paused = false;
  updateToggleLabel();
  await saveProgress();
  await speakNext();
}

async function speakNext() {
  if (!state.speaking || state.paused) return;
  const token = state.ttsToken;
  if (state.speakFrom >= state.paragraphs.length) {
    state.speaking = false;
    updateToggleLabel();
    await saveProgress({ paragraphIndex: 0 });
    setStatus("本章朗讀完畢");
    if (state.chapterIndex < (state.book?.chapters.length || 0) - 1) {
      setStatus("本章朗讀完畢，載入下一章…");
      await loadChapter(state.chapterIndex + 1, {
        autoplay: true,
        paragraphIndex: 0,
      });
    }
    return;
  }

  const i = state.speakFrom;
  const text = state.paragraphs[i];
  clearSpeakingClass();
  const node = el.content.children[i];
  if (node) {
    node.classList.add("speaking");
    node.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  await saveProgress({ paragraphIndex: i });

  try {
    if (useOpenAiTts()) {
      await speakOpenAiParagraph(text, token);
    } else {
      await speakBrowserParagraph(text, token);
    }
  } catch (err) {
    console.warn("tts error, fallback browser", err);
    if (useOpenAiTts()) {
      setStatus(`雲端 TTS 失敗，改用瀏覽器語音：${err.message || err}`);
      try {
        await speakBrowserParagraph(text, token);
      } catch (e2) {
        setStatus(`朗讀失敗：${e2.message || e2}`);
        state.speaking = false;
        updateToggleLabel();
        return;
      }
    } else {
      setStatus(`朗讀失敗：${err.message || err}`);
      state.speaking = false;
      updateToggleLabel();
      return;
    }
  }

  if (token !== state.ttsToken || !state.speaking || state.paused) return;
  state.speakFrom = i + 1;
  await saveProgress({ paragraphIndex: state.speakFrom });
  await speakNext();
}

function speakBrowserParagraph(text, token) {
  return new Promise((resolve, reject) => {
    if (!("speechSynthesis" in window)) {
      reject(new Error("此瀏覽器不支援語音合成"));
      return;
    }
    pickZhTwFemaleVoice();
    // iOS quirk: cancel then speak in same turn
    try {
      speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-TW";
    u.rate = state.rate;
    u.volume = 1;
    if (state.voice) u.voice = state.voice;
    let done = false;
    const finish = (fn) => (ev) => {
      if (done) return;
      done = true;
      fn(ev);
    };
    u.onend = finish(() => resolve());
    u.onerror = finish((ev) => {
      // interrupted by cancel is ok
      if (ev?.error === "interrupted" || ev?.error === "canceled") resolve();
      else reject(new Error(ev?.error || "speech error"));
    });
    speechSynthesis.speak(u);
    // some mobile browsers stall; watchdog nudge
    setTimeout(() => {
      if (token !== state.ttsToken) return;
      if (speechSynthesis.paused) {
        try {
          speechSynthesis.resume();
        } catch {
          /* ignore */
        }
      }
    }, 250);
  });
}

async function speakOpenAiParagraph(text, token) {
  const s = loadSettings();
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openai-key": s.openaiKey,
    },
    body: JSON.stringify({
      text,
      voice: s.openaiVoice || "nova",
      speed: state.rate,
      model: "tts-1-hd",
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `TTS HTTP ${res.status}`);
  }
  if (token !== state.ttsToken) return;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const audio = el.ttsAudio;
  audio.src = url;
  audio.playbackRate = 1;
  state.currentAudio = audio;
  await new Promise((resolve, reject) => {
    const clean = () => {
      URL.revokeObjectURL(url);
      audio.onended = null;
      audio.onerror = null;
    };
    audio.onended = () => {
      clean();
      resolve();
    };
    audio.onerror = () => {
      clean();
      reject(new Error("音訊播放失敗"));
    };
    const p = audio.play();
    if (p && p.then) {
      p.catch((e) => {
        clean();
        reject(e);
      });
    }
  });
}

async function pauseSpeech() {
  if (!state.speaking) return;
  state.paused = true;
  updateToggleLabel();
  try {
    if (useOpenAiTts() && el.ttsAudio && !el.ttsAudio.paused) el.ttsAudio.pause();
    else speechSynthesis.pause();
  } catch {
    /* ignore */
  }
  await saveProgress();
  setStatus("已暫停（進度已記住）");
}

async function resumeSpeech() {
  await unlockAudio();
  if (!state.speaking) {
    await speakFrom(state.speakFrom || 0);
    return;
  }
  state.paused = false;
  updateToggleLabel();
  try {
    if (useOpenAiTts() && el.ttsAudio?.src) {
      await el.ttsAudio.play();
      // after audio ends, speakNext chain continues via onended already set
      // if paused mid-chain, need to continue loop — audio onended will fire
    } else {
      speechSynthesis.resume();
      // if utterance was lost (iOS), restart paragraph
      if (!speechSynthesis.speaking && !speechSynthesis.pending) {
        await speakFrom(state.speakFrom || 0);
        return;
      }
    }
  } catch {
    await speakFrom(state.speakFrom || 0);
    return;
  }
  setStatus("繼續朗讀");
}

async function togglePlayPause() {
  await unlockAudio();
  if (!state.speaking) {
    await speakFrom(state.speakFrom || 0);
  } else if (state.paused) {
    await resumeSpeech();
  } else {
    await pauseSpeech();
  }
}

/* ---------------- library UI ---------------- */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function renderLibrary() {
  const books = await getBooks();
  if (!el.libraryList) return;
  el.libraryList.innerHTML = "";
  el.libraryEmpty.hidden = books.length > 0;

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
    btn.addEventListener("click", async () => {
      await unlockAudio();
      await openBook(withProgress.sourceUrl, { resume: true, autoplay: false });
    });
    const btnSpeak = document.createElement("button");
    btnSpeak.type = "button";
    btnSpeak.className = "ghost";
    btnSpeak.textContent = "繼續唸";
    btnSpeak.addEventListener("click", async () => {
      await unlockAudio();
      await openBook(withProgress.sourceUrl, { resume: true, autoplay: true });
    });
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
    meta.append(title, sub);
    const actions = document.createElement("div");
    actions.className = "actions";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "primary";
    openBtn.textContent = "開啟";
    openBtn.addEventListener("click", async () => {
      await unlockAudio();
      await openBook(rec.sourceUrl, { resume: true, autoplay: false });
    });
    const contBtn = document.createElement("button");
    contBtn.type = "button";
    contBtn.className = "ghost";
    contBtn.textContent = "繼續唸";
    contBtn.addEventListener("click", async () => {
      await unlockAudio();
      await openBook(rec.sourceUrl, { resume: true, autoplay: true });
    });
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "ghost danger";
    delBtn.textContent = "刪除";
    delBtn.addEventListener("click", async () => {
      if (confirm(`刪除「${rec.title}」的網站與進度紀錄？`)) {
        await removeBook(rec.sourceUrl);
        await renderLibrary();
        setStatus("已刪除紀錄");
      }
    });
    actions.append(openBtn, contBtn, delBtn);
    li.append(meta, actions);
    el.libraryList.appendChild(li);
  });
}

function showResumeBanner(rec) {
  if (!el.resumeBanner || !rec?.progress) {
    if (el.resumeBanner) {
      el.resumeBanner.hidden = true;
      el.resumeBanner.innerHTML = "";
    }
    return;
  }
  el.resumeBanner.hidden = false;
  el.resumeBanner.innerHTML = "";
  const text = document.createElement("p");
  text.innerHTML = `<strong>上次進度</strong> · ${escapeHtml(formatProgress(rec))}`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "primary";
  btn.textContent = "從上次繼續唸";
  btn.addEventListener("click", async () => {
    await unlockAudio();
    await resumeFromSaved({ autoplay: true });
  });
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "ghost";
  dismiss.textContent = "稍後";
  dismiss.addEventListener("click", () => {
    el.resumeBanner.hidden = true;
  });
  el.resumeBanner.append(text, btn, dismiss);
}

/* ---------------- chapters / commands ---------------- */

function normalizeCmd(raw) {
  return String(raw || "")
    .trim()
    .replace(/[０-９]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30),
    )
    .replace(/[，。！？、；：]/g, " ")
    .replace(/\s+/g, " ");
}

function chineseToNumber(raw) {
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const digits = {
    零: 0,
    〇: 0,
    一: 1,
    壹: 1,
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
  await upsertBook({
    sourceUrl: data.sourceUrl || url,
    title: data.title,
    author: data.author || "",
    chapterCount: data.chapterCount,
  });
  renderChapterList();
  await renderLibrary();
  el.setup.hidden = true;
  el.reader.hidden = false;

  const rec = await getBookRecord(data.sourceUrl || url);
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
    setStatus(`已載入 ${data.chapterCount} 章 · 還原進度`);
  } else {
    setStatus(`已載入 ${data.chapterCount} 章`);
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
      closePanels();
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
  await saveProgress({
    chapterIndex: index,
    chapterTitle: data.title || ch.title,
    chapterUrl: data.url || ch.url,
    paragraphIndex: state.speakFrom,
  });
  setStatus(`已就緒：${data.title || ch.title}`);
  const rec = await getBookRecord(state.book.sourceUrl);
  if (showResumePrompt && rec?.progress) showResumeBanner(rec);
  else if (el.resumeBanner) el.resumeBanner.hidden = true;

  if (autoplay) await speakFrom(state.speakFrom);
  else if (state.speakFrom > 0) {
    el.content.children[state.speakFrom]?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }
  updateToggleLabel();
}

async function resumeFromSaved({ autoplay = true } = {}) {
  if (!state.book) {
    const books = await getBooks();
    const rec = books.find((b) => b.progress && b.progress.chapterIndex != null);
    if (!rec) {
      setStatus("沒有可繼續的進度");
      return;
    }
    await openBook(rec.sourceUrl, { resume: true, autoplay });
    return;
  }
  const rec = await getBookRecord(state.book.sourceUrl);
  if (!rec?.progress) {
    setStatus("這本書還沒有進度，從頭朗讀");
    await speakFrom(0);
    return;
  }
  const p = rec.progress;
  let idx = p.chapterIndex;
  if (idx == null) {
    idx = state.book.chapters.findIndex((c) => c.url === p.chapterUrl);
  }
  if (idx < 0) {
    setStatus("找不到上次章節，從頭朗讀");
    await speakFrom(0);
    return;
  }
  if (idx !== state.chapterIndex) {
    await loadChapter(idx, {
      autoplay,
      paragraphIndex: p.paragraphIndex || 0,
    });
  } else if (autoplay) {
    await speakFrom(p.paragraphIndex || 0);
  } else {
    state.speakFrom = p.paragraphIndex || 0;
    setStatus(`已定位到上次進度：${formatProgress(rec)}`);
  }
  if (el.resumeBanner) el.resumeBanner.hidden = true;
}

async function runCommand(raw) {
  const text = normalizeCmd(raw);
  if (!text) {
    setStatus("請輸入指令，例如：從第 10 章開始唸");
    return;
  }
  await unlockAudio();
  setStatus(`指令：${text}`);

  let m =
    text.match(
      /從第\s*([零〇一二兩三四五六七八九十百千\d]+)\s*章(?:開始)?(?:唸|念|讀|朗讀)?/,
    ) ||
    text.match(
      /第\s*([零〇一二兩三四五六七八九十百千\d]+)\s*章(?:開始)?(?:唸|念|讀|朗讀)?/,
    ) ||
    text.match(
      /(?:唸|念|讀|朗讀)\s*第\s*([零〇一二兩三四五六七八九十百千\d]+)\s*章/,
    );
  if (m) {
    if (!state.book) {
      setStatus("請先載入目錄");
      return;
    }
    const n = chineseToNumber(m[1]);
    const idx = findChapterByNumber(n);
    if (idx < 0 || Number.isNaN(n)) {
      setStatus(`找不到第 ${m[1]} 章`);
      return;
    }
    await loadChapter(idx, { autoplay: true, paragraphIndex: 0 });
    return;
  }

  if (/^(暫停|停一下|先停|pause)$/i.test(text) || text === "停") {
    await pauseSpeech();
    return;
  }
  if (/繼續唸|繼續念|繼續朗讀|從上次繼續|接著唸|接著念|續唸|续读/.test(text)) {
    await resumeFromSaved({ autoplay: true });
    return;
  }
  if (/^(繼續|恢复|恢復|接著|resume|continue)$/i.test(text)) {
    if (state.speaking || state.paused) await resumeSpeech();
    else await resumeFromSaved({ autoplay: true });
    return;
  }
  if (/下一章|下章|next/i.test(text)) {
    if (!state.book) return setStatus("請先載入目錄");
    await loadChapter(
      Math.min(state.book.chapters.length - 1, state.chapterIndex + 1),
      { autoplay: true, paragraphIndex: 0 },
    );
    return;
  }
  if (/上一章|上章|prev/i.test(text)) {
    if (!state.book) return setStatus("請先載入目錄");
    await loadChapter(Math.max(0, state.chapterIndex - 1), {
      autoplay: true,
      paragraphIndex: 0,
    });
    return;
  }
  if (/^(開始)?(朗讀|唸|念|讀|播放)$/.test(text) || /開始朗讀|開始唸|play/i.test(text)) {
    await speakFrom(state.speakFrom || 0);
    return;
  }
  if (/停止|關掉語音|stop/i.test(text)) {
    stopSpeech();
    await saveProgress();
    setStatus("已停止朗讀（進度已記住）");
    return;
  }
  if (/速度\s*([0-9.]+)/.test(text)) {
    const r = Number(text.match(/速度\s*([0-9.]+)/)[1]);
    if (r >= 0.5 && r <= 2) {
      state.rate = r;
      el.rate.value = String(r);
      el.rateLabel.textContent = `${r.toFixed(1)}×`;
      await saveProgress({ rate: r });
      setStatus(`速度設為 ${r}×`);
    }
    return;
  }
  if (/搜尋|找/.test(text)) {
    const q = text.replace(/.*(?:搜尋|找)\s*/, "").trim();
    if (q) await jumpToSearch(q, true);
    return;
  }

  setStatus(`無法辨識「${text}」。試試：從第 10 章開始唸／繼續唸／暫停／下一章`);
}

async function jumpToSearch(q, thenRead) {
  const needle = q.trim();
  if (!needle) return;
  const idx = state.paragraphs.findIndex((p) => p.includes(needle));
  if (idx < 0) {
    setStatus(`本章找不到「${needle}」`);
    return;
  }
  el.content.querySelectorAll("p.hit").forEach((p) => p.classList.remove("hit"));
  el.content.children[idx]?.classList.add("hit");
  el.content.children[idx]?.scrollIntoView({ behavior: "smooth", block: "center" });
  state.speakFrom = idx;
  await saveProgress({ paragraphIndex: idx });
  setStatus(`已跳到第 ${idx + 1} 段`);
  if (thenRead) {
    await unlockAudio();
    await speakFrom(idx);
  }
}

/* ---------------- mic / panels ---------------- */

function setupRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = document.getElementById("btn-mic");
  if (!SR) {
    el.micHint.textContent =
      "此瀏覽器（常見於 iOS Safari）不支援語音辨識。請用下方「文字指令」——已保證可用。";
    btn.title = "不支援語音辨識";
    btn.addEventListener("click", () => {
      el.cmdInput?.focus();
      setStatus("請改用文字指令（此裝置無語音辨識）");
    });
    return;
  }
  el.micHint.textContent =
    "語音可用。若無反應請允許麥克風，或直接用文字指令。";
  const rec = new SR();
  rec.lang = "zh-TW";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (ev) => {
    const said = ev.results?.[0]?.[0]?.transcript || "";
    el.cmdInput.value = said;
    runCommand(said);
  };
  rec.onerror = (ev) => {
    state.listening = false;
    btn.classList.remove("primary");
    setStatus(
      `語音辨識失敗（${ev.error || "unknown"}）。請改用文字指令。`,
    );
  };
  rec.onend = () => {
    state.listening = false;
    btn.classList.remove("primary");
  };
  state.recognition = rec;
  btn.addEventListener("click", async () => {
    await unlockAudio();
    if (state.listening) {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      rec.start();
      state.listening = true;
      btn.classList.add("primary");
      setStatus("正在聽…可說「從第 10 章開始唸」或「繼續唸」");
    } catch (err) {
      setStatus(`無法啟動麥克風：${err.message || err}。請用文字指令。`);
    }
  });
}

function openDrawer() {
  el.settings.hidden = true;
  el.drawer.hidden = false;
  el.backdrop.hidden = false;
}
function openSettings() {
  fillSettingsForm();
  el.drawer.hidden = true;
  el.settings.hidden = false;
  el.backdrop.hidden = false;
}
function closePanels() {
  el.drawer.hidden = true;
  el.settings.hidden = true;
  el.backdrop.hidden = true;
}

function goHome() {
  stopSpeech();
  el.reader.hidden = true;
  el.setup.hidden = false;
  renderLibrary();
  setStatus("已回到書單。");
}

function bindUi() {
  // unlock on first interaction
  const unlockOnce = () => {
    unlockAudio();
  };
  document.addEventListener("pointerdown", unlockOnce, { passive: true });
  document.addEventListener("touchstart", unlockOnce, { passive: true });

  el.tocForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await unlockAudio();
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
  document.getElementById("btn-settings").addEventListener("click", openSettings);
  document
    .getElementById("btn-close-drawer")
    .addEventListener("click", closePanels);
  document
    .getElementById("btn-close-settings")
    .addEventListener("click", closePanels);
  el.backdrop.addEventListener("click", closePanels);

  document.getElementById("btn-home").addEventListener("click", goHome);
  document.getElementById("btn-resume").addEventListener("click", async () => {
    await unlockAudio();
    await resumeFromSaved({ autoplay: true });
  });

  el.btnToggle.addEventListener("click", () => togglePlayPause());
  document.getElementById("btn-prev").addEventListener("click", async () => {
    await unlockAudio();
    await loadChapter(Math.max(0, state.chapterIndex - 1), {
      autoplay: false,
      paragraphIndex: 0,
    });
  });
  document.getElementById("btn-next").addEventListener("click", async () => {
    await unlockAudio();
    await loadChapter(
      Math.min((state.book?.chapters.length || 1) - 1, state.chapterIndex + 1),
      { autoplay: false, paragraphIndex: 0 },
    );
  });

  el.rate.addEventListener("input", () => {
    state.rate = Number(el.rate.value);
    el.rateLabel.textContent = `${state.rate.toFixed(1)}×`;
    saveProgress({ rate: state.rate });
  });

  el.searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await unlockAudio();
    await jumpToSearch(el.searchQ.value, el.searchRead.checked);
  });

  el.cmdForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await unlockAudio();
    await runCommand(el.cmdInput.value);
  });
  el.cmdInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      await unlockAudio();
      await runCommand(el.cmdInput.value);
    }
  });

  el.ttsEngine.addEventListener("change", () =>
    saveSettings({ ttsEngine: el.ttsEngine.value }),
  );
  el.openaiKey.addEventListener("change", () =>
    saveSettings({ openaiKey: el.openaiKey.value.trim() }),
  );
  el.openaiVoice.addEventListener("change", () =>
    saveSettings({ openaiVoice: el.openaiVoice.value }),
  );
  el.syncCode.addEventListener("change", () =>
    saveSettings({ syncCode: el.syncCode.value.trim().toUpperCase() }),
  );

  document.getElementById("btn-sync-push").addEventListener("click", async () => {
    try {
      await pushSync();
    } catch (err) {
      setStatus(String(err.message || err));
    }
  });
  document.getElementById("btn-sync-pull").addEventListener("click", async () => {
    try {
      const lib = await pullSync();
      const last = lib.lastSourceUrl || lib.books?.[0]?.sourceUrl;
      if (last) await openBook(last, { resume: true, autoplay: false });
    } catch (err) {
      setStatus(String(err.message || err));
    }
  });
  document.getElementById("btn-sync-copy").addEventListener("click", async () => {
    try {
      let code = loadSettings().syncCode;
      if (!code) code = await pushSync();
      const u = new URL(location.origin);
      u.searchParams.set("sync", code);
      await navigator.clipboard.writeText(u.toString());
      setStatus("已複製書籤連結");
    } catch (err) {
      setStatus(String(err.message || err));
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.speaking && !state.paused) {
      pauseSpeech();
    }
  });

  window.addEventListener("pagehide", () => {
    if (state.book) saveProgress();
  });
  window.addEventListener("beforeunload", () => {
    if (state.book) {
      // sync localStorage immediately
      const store = loadStoreSync();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    }
  });
}

async function bootFromUrl() {
  const u = new URL(location.href);
  const sync = u.searchParams.get("sync");
  if (sync) {
    try {
      await pullSync(sync);
    } catch (err) {
      setStatus(`同步碼拉取失敗：${err.message || err}`);
    }
  }
  const book = u.searchParams.get("book");
  const c = u.searchParams.get("c");
  const p = u.searchParams.get("p");
  if (book) {
    // seed progress from URL if provided
    if (c != null) {
      await upsertBook({
        sourceUrl: book,
        progress: {
          chapterIndex: Number(c) || 0,
          paragraphIndex: Number(p) || 0,
        },
      });
    }
    await openBook(book, { resume: true, autoplay: false });
    return true;
  }
  return false;
}

async function boot() {
  ensureVoices();
  bindUi();
  setupRecognition();
  fillSettingsForm();
  await renderLibrary();

  const fromUrl = await bootFromUrl();
  if (fromUrl) return;

  const store = await loadStore();
  if (store.lastSourceUrl) el.tocUrl.value = store.lastSourceUrl;
  const last = store.lastSourceUrl && (await getBookRecord(store.lastSourceUrl));
  if (last?.progress && last.progress.chapterIndex != null) {
    // 進站自動還原到上次章節（不自動出聲，避免被瀏覽器擋）
    setStatus("正在還原上次進度…");
    try {
      await openBook(last.sourceUrl, { resume: true, autoplay: false });
      setStatus(`已還原：${formatProgress(last)} · 按「朗讀」或說「繼續唸」`);
      return;
    } catch (err) {
      setStatus(`還原失敗：${err.message || err}`);
    }
  }
  setStatus(
    (await getBooks()).length
      ? "就緒。可從書單繼續，或載入新目錄。"
      : "就緒。載入目錄後會記住進度；建議在設定貼 OpenAI Key 以獲較自然語音。",
  );
}

boot();
