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
                default: "google-wavenet-cmn-TW",
                providers: ["google", "openai", "browser"],
                hasGoogle: Boolean(env.GOOGLE_TTS_API_KEY),
                hasOpenAI: Boolean(env.OPENAI_API_KEY),
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
            "未設定雲端 TTS Key。預設建議 Google WaveNet cmn-TW（最便宜且台灣口音）。請在設定貼上 Google TTS API Key，或 wrangler secret put GOOGLE_TTS_API_KEY。",
          code: "NO_KEY",
          recommend: "google",
        },
        400,
      );
    }
  }

  if (provider === "google") {
    return await ttsGoogle(text, speed, body, googleKey);
  }
  if (provider === "openai") {
    return await ttsOpenAi(text, speed, body, openaiKey);
  }
  return json({ error: `未知 provider：${provider}` }, 400);
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
  const voiceName = [
    "cmn-TW-Wavenet-A",
    "cmn-TW-Wavenet-B",
    "cmn-TW-Wavenet-C",
    "cmn-TW-Standard-A",
    "cmn-TW-Standard-B",
    "cmn-TW-Standard-C",
  ].includes(body.voice)
    ? body.voice
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
          name: voiceName,
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
    return json(
      {
        error: `Google TTS 失敗（${upstream.status}）`,
        detail: errText.slice(0, 400),
      },
      502,
    );
  }
  const data = await upstream.json();
  if (!data.audioContent) {
    return json({ error: "Google TTS 未回傳 audioContent" }, 502);
  }
  const bin = Uint8Array.from(atob(data.audioContent), (c) => c.charCodeAt(0));
  return new Response(bin, {
    status: 200,
    headers: ttsHeaders({ "x-tts-provider": "google", "x-tts-voice": voiceName }),
  });
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
    if (/上一章|下一章|目錄|返回|加入書架/.test(t) && t.length < 20) continue;
    ps.push(t);
  }

  if (ps.length === 0) {
    const plain = decodeHtml(stripTags(block))
      .replace(/\r/g, "")
      .split(/\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 8);
    return plain.slice(0, 200);
  }
  return ps;
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
