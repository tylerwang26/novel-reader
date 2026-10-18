/**
 * Novel Reader Worker — proxy chapters + progress sync (KV) + OpenAI TTS proxy
 */

const ALLOWED_HOSTS = new Set([
  "big5.quanben5.com",
  "www.quanben5.com",
  "quanben5.com",
]);

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
/** @type {Map<string, { count: number, reset: number }>} */
const rateBuckets = new Map();

const DEFAULT_TOC =
  "https://big5.quanben5.com/amp/n/fanrenxiuxianchuan/xiaoshuo.html";

const SYNC_TTL_SECONDS = 60 * 60 * 24 * 180; // 180 days

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") {
        return cors(new Response(null, { status: 204 }));
      }
      try {
        const limited = checkRate(request);
        if (limited) return cors(limited);

        if (url.pathname === "/api/health") {
          return cors(
            json({
              ok: true,
              service: "novel-reader",
              kv: Boolean(env.PROGRESS),
              tts: {
                default: "gemini-3.1-flash-tts-preview/Leda",
                language: "cmn-TW",
                providers: ["google", "openai", "browser"],
                hasGoogle: Boolean(env.GOOGLE_TTS_API_KEY),
                hasOpenAI: Boolean(env.OPENAI_API_KEY),
                geminiModel: "gemini-3.1-flash-tts-preview",
                geminiDefaultVoice: "Leda",
              },
            }),
          );
        }
        if (url.pathname === "/api/toc") {
          return cors(await handleToc(url));
        }
        if (url.pathname === "/api/chapter") {
          return cors(await handleChapter(url));
        }
        if (url.pathname === "/api/sync") {
          return cors(await handleSync(request, url, env));
        }
        if (url.pathname === "/api/tts") {
          return cors(await handleTts(request, env));
        }
        return cors(json({ error: "找不到此 API" }, 404));
      } catch (err) {
        console.error(JSON.stringify({ err: String(err), path: url.pathname }));
        return cors(json({ error: String(err?.message || err) }, 502));
      }
    }

    return env.ASSETS.fetch(request);
  },
};

function checkRate(request) {
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "anon";
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.reset) {
    bucket = { count: 0, reset: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_MAX) {
    return json(
      { error: "請求過於頻繁，請稍後再試（約每分鐘 60 次）" },
      429,
    );
  }
  return null;
}

async function handleSync(request, url, env) {
  if (!env.PROGRESS) {
    return json({ error: "PROGRESS KV 未綁定" }, 503);
  }

  if (request.method === "GET") {
    const readerId = String(url.searchParams.get("readerId") || "")
      .trim()
      .toUpperCase();
    const code = String(url.searchParams.get("code") || "")
      .trim()
      .toUpperCase();
    const key = readerId
      ? `reader:${readerId}`
      : code
        ? `sync:${code}`
        : "";
    if (!key) return json({ error: "需要 readerId 或 code" }, 400);
    if (readerId && !/^[A-Z0-9]{8,20}$/.test(readerId)) {
      return json({ error: "readerId 格式不正確" }, 400);
    }
    if (code && !readerId && !/^[A-Z0-9]{6,12}$/.test(code)) {
      return json({ error: "同步碼格式不正確" }, 400);
    }
    const raw = await env.PROGRESS.get(key);
    if (!raw) return json({ error: "找不到此進度或尚未上傳", code: "NOT_FOUND" }, 404);
    const data = JSON.parse(raw);
    return json({
      ok: true,
      readerId: readerId || data.readerId || null,
      code: code || null,
      library: data.library || data,
      updatedAt: data.updatedAt || null,
    });
  }

  if (request.method === "POST" || request.method === "PUT") {
    const body = await request.json().catch(() => ({}));
    const library = body.library;
    if (!library || !Array.isArray(library.books)) {
      return json({ error: "缺少 library.books" }, 400);
    }
    const packedLib = JSON.stringify(library);
    if (packedLib.length > 400_000) {
      return json({ error: "進度資料過大" }, 413);
    }

    let readerId = String(body.readerId || "")
      .trim()
      .toUpperCase();
    if (readerId && !/^[A-Z0-9]{8,20}$/.test(readerId)) {
      return json({ error: "readerId 格式不正確" }, 400);
    }
    if (!readerId) readerId = randomCode(12);

    let code = String(body.code || "")
      .trim()
      .toUpperCase();
    if (code && !/^[A-Z0-9]{6,12}$/.test(code)) {
      return json({ error: "同步碼格式不正確" }, 400);
    }
    // backup code mirrors reader prefix for human sharing
    if (!code) code = readerId.slice(0, 8);

    const payload = JSON.stringify({
      readerId,
      code,
      updatedAt: Date.now(),
      library,
    });

    await env.PROGRESS.put(`reader:${readerId}`, payload, {
      expirationTtl: SYNC_TTL_SECONDS,
    });
    await env.PROGRESS.put(`sync:${code}`, payload, {
      expirationTtl: SYNC_TTL_SECONDS,
    });
    return json({ ok: true, readerId, code });
  }

  return json({ error: "Method not allowed" }, 405);
}

const GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const GEMINI_FEMALE = [
  "Leda",
  "Aoede",
  "Kore",
  "Callirrhoe",
  "Autonoe",
  "Despina",
  "Erinome",
  "Gacrux",
  "Laomedeia",
  "Pulcherrima",
  "Sulafat",
  "Vindemiatrix",
  "Zephyr",
  "Achernar",
];
const WAVENET_VOICES = [
  "cmn-TW-Wavenet-A",
  "cmn-TW-Wavenet-B",
  "cmn-TW-Wavenet-C",
  "cmn-TW-Standard-A",
  "cmn-TW-Standard-B",
  "cmn-TW-Standard-C",
];

async function handleTts(request, env) {
  if (request.method !== "POST") {
    return json({ error: "POST only" }, 405);
  }
  const body = await request.json().catch(() => ({}));
  const text = String(body.text || "").trim();
  if (!text) return json({ error: "缺少 text" }, 400);
  if (text.length > 2200) return json({ error: "單段文字過長" }, 400);

  const speed = Math.min(1.5, Math.max(0.75, Number(body.speed) || 1));
  let provider = String(body.provider || "auto").toLowerCase();

  const googleKey =
    request.headers.get("x-google-tts-key") || env.GOOGLE_TTS_API_KEY || "";
  const openaiKey =
    request.headers.get("x-openai-key") || env.OPENAI_API_KEY || "";

  if (provider === "auto") {
    if (googleKey) provider = "google";
    else if (openaiKey) provider = "openai";
    else {
      return json(
        {
          error:
            "未設定雲端 TTS Key。預設 Gemini 3.1 Flash TTS · Leda（台灣華語）。請綁定 GOOGLE_TTS_API_KEY。",
          code: "NO_KEY",
          recommend: "google",
        },
        400,
      );
    }
  }

  if (provider === "google" || provider === "gemini") {
    return await ttsGoogle(text, speed, body, googleKey);
  }
  if (provider === "openai") {
    return await ttsOpenAi(text, speed, body, openaiKey);
  }
  return json({ error: `未知 provider：${provider}` }, 400);
}

function bodyVoiceSafe(v) {
  return String(v || "");
}

function resolveGooglePlan(body) {
  const voice = bodyVoiceSafe(body.voice);
  const quality = String(body.quality || body.model || "").toLowerCase();
  const wantGemini =
    quality.includes("gemini") ||
    GEMINI_FEMALE.includes(voice) ||
    (!WAVENET_VOICES.includes(voice) && !quality.includes("wavenet") && !quality.includes("standard"));

  if (WAVENET_VOICES.includes(voice) || quality.includes("wavenet") || quality.includes("standard")) {
    return {
      mode: "wavenet",
      voice: WAVENET_VOICES.includes(voice) ? voice : "cmn-TW-Wavenet-A",
    };
  }
  if (wantGemini || !voice) {
    return {
      mode: "gemini",
      voice: GEMINI_FEMALE.includes(voice) ? voice : "Leda",
      model: GEMINI_TTS_MODEL,
    };
  }
  return { mode: "wavenet", voice: "cmn-TW-Wavenet-A" };
}

async function ttsGoogle(text, speed, body, key) {
  if (!key) {
    return json(
      {
        error:
          "未設定 Google TTS API Key（設定頁或 secret GOOGLE_TTS_API_KEY）",
        code: "NO_KEY",
      },
      400,
    );
  }

  const plan = resolveGooglePlan(body);
  const allowFallback = body.fallback !== false;

  if (plan.mode === "gemini") {
    const geminiRes = await ttsGeminiCloud(text, speed, plan.voice, key);
    if (geminiRes.ok) return geminiRes.response;
    if (allowFallback) {
      const wave = await ttsWavenet(
        text,
        speed,
        "cmn-TW-Wavenet-A",
        key,
        {
          "x-tts-fallback": "wavenet",
          "x-tts-warning": encodeURIComponent(
            geminiRes.userMessage || "Gemini TTS 不可用，已改用 WaveNet",
          ),
        },
      );
      if (wave.ok) return wave.response;
    }
    return json(
      {
        error: geminiRes.userMessage || "Gemini TTS 失敗",
        code: geminiRes.code || "GEMINI_FAIL",
        detail: geminiRes.detail?.slice(0, 500),
        enableHint:
          "請在 Google Cloud 專案啟用 Vertex AI API（aiplatform.googleapis.com），Gemini-TTS 經 Cloud Text-to-Speech 需此權限。WaveNet 仍可用。",
      },
      geminiRes.status || 502,
    );
  }

  const wave = await ttsWavenet(text, speed, plan.voice, key);
  if (wave.ok) return wave.response;
  return json(
    {
      error: wave.userMessage || "Google TTS 失敗",
      detail: wave.detail?.slice(0, 400),
    },
    wave.status || 502,
  );
}

async function ttsGeminiCloud(text, speed, voiceName, key) {
  const voice = GEMINI_FEMALE.includes(voiceName) ? voiceName : "Leda";
  const prompt =
    "用自然、流利的台灣國語（華語台灣口音）女聲朗讀小說正文，語氣溫柔沉穩、清晰好懂，不要英文腔。";

  const upstream = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text, prompt },
        voice: {
          languageCode: "cmn-TW",
          name: voice,
          modelName: GEMINI_TTS_MODEL,
        },
        audioConfig: {
          audioEncoding: "MP3",
          speakingRate: speed,
        },
      }),
    },
  );

  const errText = upstream.ok ? "" : await upstream.text();
  if (!upstream.ok) {
    let code = "GEMINI_FAIL";
    let userMessage = `Gemini TTS 失敗（${upstream.status}）`;
    if (/aiplatform\.googleapis\.com|Agent Platform API/i.test(errText)) {
      code = "VERTEX_AI_DISABLED";
      userMessage =
        "Gemini TTS 需要啟用 Vertex AI API（aiplatform.googleapis.com）。請到 Google Cloud Console 為此專案啟用後再試。";
    } else if (/PERMISSION_DENIED|API_KEY_SERVICE_BLOCKED/i.test(errText)) {
      code = "API_BLOCKED";
      userMessage = "此 API Key 未授權 Gemini／Vertex TTS，請檢查金鑰限制與 API 啟用狀態。";
    }
    return { ok: false, status: upstream.status, code, userMessage, detail: errText };
  }

  const data = await upstream.json();
  if (!data.audioContent) {
    return {
      ok: false,
      status: 502,
      code: "NO_AUDIO",
      userMessage: "Gemini TTS 未回傳 audioContent",
    };
  }
  const bin = Uint8Array.from(atob(data.audioContent), (c) => c.charCodeAt(0));
  return {
    ok: true,
    response: new Response(bin, {
      status: 200,
      headers: ttsHeaders({
        "x-tts-provider": "gemini",
        "x-tts-model": GEMINI_TTS_MODEL,
        "x-tts-voice": voice,
      }),
    }),
  };
}

async function ttsWavenet(text, speed, voiceName, key, extraHeaders = {}) {
  const voice = WAVENET_VOICES.includes(voiceName)
    ? voiceName
    : "cmn-TW-Wavenet-A";
  const upstream = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: "cmn-TW",
          name: voice,
        },
        audioConfig: {
          audioEncoding: "MP3",
          speakingRate: speed,
        },
      }),
    },
  );
  if (!upstream.ok) {
    const errText = await upstream.text();
    return {
      ok: false,
      status: upstream.status,
      userMessage: `Google WaveNet 失敗（${upstream.status}）`,
      detail: errText,
    };
  }
  const data = await upstream.json();
  if (!data.audioContent) {
    return { ok: false, status: 502, userMessage: "WaveNet 未回傳 audioContent" };
  }
  const bin = Uint8Array.from(atob(data.audioContent), (c) => c.charCodeAt(0));
  return {
    ok: true,
    response: new Response(bin, {
      status: 200,
      headers: ttsHeaders({
        "x-tts-provider": "google",
        "x-tts-voice": voice,
        ...extraHeaders,
      }),
    }),
  };
}

async function ttsOpenAi(text, speed, body, key) {
  if (!key) {
    return json(
      {
        error:
          "未設定 OpenAI API Key（設定頁或 secret OPENAI_API_KEY）",
        code: "NO_KEY",
      },
      400,
    );
  }
  const voice = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"].includes(
    body.voice,
  )
    ? body.voice
    : "nova";
  const model = body.model === "tts-1-hd" ? "tts-1-hd" : "tts-1";

  const upstream = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      speed,
      response_format: "mp3",
    }),
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    return json(
      {
        error: `OpenAI TTS 失敗（${upstream.status}）`,
        detail: errText.slice(0, 300),
      },
      502,
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: ttsHeaders({ "x-tts-provider": "openai", "x-tts-voice": voice }),
  });
}

function ttsHeaders(extra = {}) {
  return {
    "content-type": "audio/mpeg",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "content-type, x-openai-key, x-google-tts-key",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    ...extra,
  };
}

function randomCode(n) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < n; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

async function handleToc(url) {
  const target = url.searchParams.get("url") || DEFAULT_TOC;
  const pageUrl = normalizeUrl(target);
  assertAllowed(pageUrl);

  const html = await fetchText(pageUrl);
  const title =
    textBetween(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
    textBetween(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ||
    "未命名小說";
  const author =
    matchOne(html, /作者[:：]\s*<span[^>]*class="author"[^>]*>([^<]+)/i) ||
    matchOne(html, /作者[:：]\s*([^<\n]+)/i) ||
    "";

  const base = new URL(pageUrl);
  const chapters = [];
  const seen = new Set();
  const re =
    /<a[^>]+href="([^"]+)"[^>]*>\s*(?:<span>)?([^<]+?)(?:<\/span>)?\s*<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const name = decodeHtml(m[2]).trim();
    if (!href || !name) continue;
    if (!/\/n\/[^/]+\/\d+\.html/i.test(href)) continue;
    if (!/第.+章|序章|楔子|後記|番外|完結/.test(name) && !/^\d/.test(name)) {
      if (!/章/.test(name)) continue;
    }
    let abs;
    try {
      abs = new URL(href, base).href;
    } catch {
      continue;
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    chapters.push({ title: name, url: abs, index: chapters.length });
  }

  const numbered = chapters.filter((c) => /第.+章/.test(c.title));
  const list = numbered.length > 10 ? numbered : chapters;
  list.forEach((c, i) => {
    c.index = i;
  });

  return json({
    title: decodeHtml(stripTags(title)).replace(/\s*小說.*$/, "").trim(),
    author: decodeHtml(stripTags(author)).trim(),
    sourceUrl: pageUrl,
    chapterCount: list.length,
    chapters: list,
  });
}

async function handleChapter(url) {
  const target = url.searchParams.get("url");
  if (!target) return json({ error: "缺少 url 參數" }, 400);
  const pageUrl = normalizeUrl(target);
  assertAllowed(pageUrl);

  const html = await fetchText(pageUrl);
  const title =
    textBetween(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
    textBetween(html, /class="title"[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/i) ||
    "本章";

  const paragraphs = extractParagraphs(html);
  const base = new URL(pageUrl);
  const prev = findNav(html, base, /上一[章頁]/);
  const next = findNav(html, base, /下一[章頁]/);
  const toc = findNav(html, base, /目錄|目录/);

  return json({
    title: decodeHtml(stripTags(title)).trim(),
    url: pageUrl,
    paragraphs,
    content: paragraphs.join("\n\n"),
    prev,
    next,
    toc,
  });
}

/**
 * Site chrome / nav / copyright — not novel body.
 * Keep conservative: only drop short or clearly non-prose lines.
 */
function isBoilerplateParagraph(raw) {
  const s = String(raw || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return true;
  const compact = s.replace(/\s+/g, "");

  // Pure navigation labels
  if (
    /^(上一[頁页章]|下一[頁页章]|目錄|目录|返回|回目錄|回目录|加入書架|加入书架|首頁|首页|書簽|书签)$/i.test(
      compact,
    )
  ) {
    return true;
  }

  // Copyright / site footer
  if (
    /©|&copy;|版權所有|版权所有|All\s*Rights\s*Reserved/i.test(s) &&
    s.length < 120
  ) {
    return true;
  }
  if (
    /全本小說網|全本小说网|完本小說|完本小说|小說閱讀網|小说阅读网/i.test(s) &&
    s.length < 40
  ) {
    return true;
  }

  // Attribution + domain junk: 「是 由】www.wcxiaoshuo.com」
  if (
    s.length < 80 &&
    /(www\.[a-z0-9.-]+\.[a-z]{2,}|https?:\/\/[^\s]+)/i.test(s) &&
    !/[\u4e00-\u9fff]{12,}/.test(s)
  ) {
    return true;
  }

  // Domain-only / near-domain lines
  if (
    /^[是由來源来源转自轉自提供\]】【\[:：]{0,10}[a-z0-9.-]+\.(com|net|org|cc|co|xyz|info)\/?$/i.test(
      compact,
    )
  ) {
    return true;
  }
  if (
    s.length < 36 &&
    /\.(com|net|org|cc)\b/i.test(s) &&
    !/[\u4e00-\u9fff]{8,}/.test(s)
  ) {
    return true;
  }

  // Short chrome leftovers
  if (
    s.length < 24 &&
    /上一[頁页]|下一[頁页]|目錄|目录|返回|書架|书架/.test(s)
  ) {
    return true;
  }

  return false;
}

function filterNovelParagraphs(list) {
  const out = [];
  for (const p of list) {
    if (!isBoilerplateParagraph(p)) out.push(p);
  }
  // Strip any trailing junk that slipped through as short lines
  while (out.length && isBoilerplateParagraph(out[out.length - 1])) {
    out.pop();
  }
  // Also peel a trailing run of chrome at end (safety)
  let end = out.length;
  while (end > 0 && isBoilerplateParagraph(out[end - 1])) end -= 1;
  return out.slice(0, end);
}

function extractParagraphs(html) {
  let block =
    matchOne(html, /<div class="wrapper">(.*?)<div class="footer/i) ||
    matchOne(html, /<div class="box_content">([\s\S]*?)<\/div>/i) ||
    matchOne(html, /<article[^>]*>([\s\S]*?)<\/article>/i) ||
    html;

  block = block.replace(/<script[\s\S]*?<\/script>/gi, "");
  block = block.replace(/<style[\s\S]*?<\/style>/gi, "");
  block = block.replace(/\[img=[^\]]+\]/gi, "");
  block = block.replace(/<amp-img[\s\S]*?<\/amp-img>/gi, "");
  block = block.replace(/<img[^>]*>/gi, "");

  const ps = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(block))) {
    let t = decodeHtml(stripTags(m[1])).replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (isBoilerplateParagraph(t)) continue;
    ps.push(t);
  }

  if (ps.length === 0) {
    const plain = decodeHtml(stripTags(block))
      .replace(/\r/g, "")
      .split(/\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 8 && !isBoilerplateParagraph(s));
    return filterNovelParagraphs(plain.slice(0, 200));
  }
  return filterNovelParagraphs(ps);
}

function findNav(html, base, labelRe) {
  const re = new RegExp(
    `<a[^>]+href="([^"]+)"[^>]*>[^<]*${labelRe.source}[^<]*</a>`,
    "i",
  );
  const m = html.match(re);
  if (!m) return null;
  try {
    return new URL(m[1], base).href;
  } catch {
    return null;
  }
}

async function fetchText(pageUrl) {
  const res = await fetch(pageUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; NovelReaderBot/1.0; +https://workers.dev)",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "zh-TW,zh;q=0.9",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`來源站回應 ${res.status}`);
  const buf = await res.arrayBuffer();
  return decodeBuffer(buf, res.headers.get("content-type") || "");
}

function decodeBuffer(buf, contentType) {
  const bytes = new Uint8Array(buf);
  const head = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.slice(0, 2048),
  );
  const m =
    head.match(/charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i) ||
    contentType.match(/charset\s*=\s*([a-zA-Z0-9_-]+)/i);
  const metaCharset = m ? m[1].toLowerCase() : "";
  const order = [];
  if (metaCharset.includes("big5")) order.push("big5");
  else if (metaCharset.includes("gb")) order.push("gbk");
  order.push("utf-8", "big5", "gbk");
  for (const enc of order) {
    try {
      const text = new TextDecoder(enc, { fatal: enc === "utf-8" }).decode(
        bytes,
      );
      if (enc !== "utf-8" || !text.includes("\uFFFD")) return text;
      if (
        enc === "utf-8" &&
        (text.match(/[\u4e00-\u9fff]/g) || []).length > 20
      ) {
        return text;
      }
    } catch {
      /* next */
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function normalizeUrl(raw) {
  let u = String(raw).trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return new URL(u).href;
}

function assertAllowed(href) {
  const host = new URL(href).hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(
      `目前僅允許代理：${[...ALLOWED_HOSTS].join(", ")}（收到 ${host}）`,
    );
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? "public, max-age=60" : "no-store",
    },
  });
}

function cors(res) {
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "content-type, x-openai-key, x-google-tts-key",
  );
  return new Response(res.body, { status: res.status, headers });
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, "");
}

function decodeHtml(s) {
  return String(s)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsaquo;/g, "›")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    );
}

function textBetween(html, re) {
  const m = html.match(re);
  return m ? m[1] : "";
}

function matchOne(html, re) {
  const m = html.match(re);
  return m ? m[1] : "";
}
