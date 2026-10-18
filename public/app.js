const DEFAULT_TOC =
  "https://big5.quanben5.com/amp/n/fanrenxiuxianchuan/xiaoshuo.html";

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
};

const el = {
  tocForm: document.getElementById("toc-form"),
  tocUrl: document.getElementById("toc-url"),
  status: document.getElementById("status"),
  setup: document.getElementById("setup-panel"),
  reader: document.getElementById("reader"),
  bookTitle: document.getElementById("book-title"),
  chapterTitle: document.getElementById("chapter-title"),
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
  let unit = 1;
  // handle 十X / X十 / X十Y / 百
  if (s.includes("百")) {
    const [a, b] = s.split("百");
    n += ((digits[a] != null ? digits[a] : 1)) * 100;
    if (b) n += chineseToNumber(b);
    return n;
  }
  if (s.includes("十")) {
    const [a, b] = s.split("十");
    const tens = a === "" ? 1 : (digits[a] != null ? digits[a] : Number(a) || 0);
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
  el.content.querySelectorAll("p.speaking").forEach((p) => p.classList.remove("speaking"));
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
  speakNext();
}

function speakNext() {
  if (!state.speaking || state.paused) return;
  if (state.speakFrom >= state.paragraphs.length) {
    state.speaking = false;
    setStatus("本章朗讀完畢");
    // auto next chapter
    if (state.chapterIndex < (state.book?.chapters.length || 0) - 1) {
      setStatus("本章朗讀完畢，載入下一章…");
      loadChapter(state.chapterIndex + 1, { autoplay: true });
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
  u.onend = () => {
    state.speakFrom = i + 1;
    speakNext();
  };
  u.onerror = () => {
    state.speakFrom = i + 1;
    speakNext();
  };
  speechSynthesis.speak(u);
}

function pauseSpeech() {
  if (!state.speaking) return;
  speechSynthesis.pause();
  state.paused = true;
  setStatus("已暫停");
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

async function loadToc(url) {
  setStatus("正在載入目錄…");
  const data = await api(`/api/toc?url=${encodeURIComponent(url)}`);
  state.book = data;
  el.bookTitle.textContent = `${data.title}${data.author ? " · " + data.author : ""}`;
  renderChapterList();
  el.setup.hidden = true;
  el.reader.hidden = false;
  setStatus(`已載入 ${data.chapterCount} 章`);
  if (data.chapters.length) {
    await loadChapter(0);
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
      loadChapter(i);
    });
    li.appendChild(btn);
    el.list.appendChild(li);
  });
}

async function loadChapter(index, { autoplay = false } = {}) {
  const ch = state.book?.chapters?.[index];
  if (!ch) return;
  stopSpeech();
  setStatus(`載入：${ch.title}`);
  const data = await api(`/api/chapter?url=${encodeURIComponent(ch.url)}`);
  state.chapterIndex = index;
  state.chapter = data;
  state.paragraphs = data.paragraphs || [];
  state.speakFrom = 0;
  el.chapterTitle.textContent = data.title || ch.title;
  el.content.innerHTML = "";
  state.paragraphs.forEach((p) => {
    const node = document.createElement("p");
    node.textContent = p;
    el.content.appendChild(node);
  });
  renderChapterList();
  setStatus(`已就緒：${data.title || ch.title}`);
  if (autoplay) speakFrom(0);
}

function openDrawer() {
  el.drawer.hidden = false;
  el.backdrop.hidden = false;
}

function closeDrawer() {
  el.drawer.hidden = true;
  el.backdrop.hidden = true;
}

function findChapterByNumber(n) {
  // 1-based human chapter number vs list index
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
    loadChapter(idx, { autoplay: true });
    return;
  }

  if (/暫停|停一下|先停/.test(text)) {
    pauseSpeech();
    return;
  }
  if (/繼續|恢復|接著/.test(text)) {
    resumeSpeech();
    return;
  }
  if (/下一章/.test(text)) {
    loadChapter(state.chapterIndex + 1, { autoplay: state.speaking || true });
    return;
  }
  if (/上一章/.test(text)) {
    loadChapter(Math.max(0, state.chapterIndex - 1), {
      autoplay: state.speaking || true,
    });
    return;
  }
  if (/^(開始)?(朗讀|唸|念|讀)$/.test(text) || /開始朗讀|開始唸/.test(text)) {
    speakFrom(state.speakFrom || 0);
    return;
  }
  if (/停止|關掉語音/.test(text)) {
    stopSpeech();
    setStatus("已停止朗讀");
    return;
  }
  if (/速度\s*([0-9.]+)/.test(text)) {
    const r = Number(text.match(/速度\s*([0-9.]+)/)[1]);
    if (r >= 0.5 && r <= 2) {
      state.rate = r;
      el.rate.value = String(r);
      el.rateLabel.textContent = `${r.toFixed(1)}×`;
      setStatus(`速度設為 ${r}×`);
    }
    return;
  }

  // search fallback inside command
  if (/搜尋|找/.test(text)) {
    const q = text.replace(/.*(?:搜尋|找)\s*/, "").trim();
    if (q) jumpToSearch(q, true);
    return;
  }

  setStatus(`無法辨識指令：「${text}」。可試「從第 3 章開始唸」`);
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
      setStatus("正在聽…請說「從第 N 章開始唸」");
    } catch {
      setStatus("無法啟動麥克風，請改用文字指令");
    }
  });
}

function bindUi() {
  el.tocForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await loadToc(el.tocUrl.value.trim() || DEFAULT_TOC);
    } catch (err) {
      setStatus(String(err.message || err));
    }
  });

  document.getElementById("btn-chapters").addEventListener("click", openDrawer);
  document.getElementById("btn-close-drawer").addEventListener("click", closeDrawer);
  el.backdrop.addEventListener("click", closeDrawer);

  document.getElementById("btn-play").addEventListener("click", () => {
    if (state.paused) resumeSpeech();
    else speakFrom(state.speakFrom || 0);
  });
  document.getElementById("btn-pause").addEventListener("click", () => {
    if (state.paused) resumeSpeech();
    else pauseSpeech();
  });
  document.getElementById("btn-prev").addEventListener("click", () => {
    loadChapter(Math.max(0, state.chapterIndex - 1));
  });
  document.getElementById("btn-next").addEventListener("click", () => {
    loadChapter(Math.min((state.book?.chapters.length || 1) - 1, state.chapterIndex + 1));
  });

  el.rate.addEventListener("input", () => {
    state.rate = Number(el.rate.value);
    el.rateLabel.textContent = `${state.rate.toFixed(1)}×`;
  });

  el.searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    jumpToSearch(el.searchQ.value, el.searchRead.checked);
  });

  el.cmdForm.addEventListener("submit", (e) => {
    e.preventDefault();
    runCommand(el.cmdInput.value);
  });
}

ensureVoices();
bindUi();
setupRecognition();
setStatus("就緒。載入目錄後即可朗讀《凡人修仙傳》。");
