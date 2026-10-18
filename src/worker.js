/**
 * Novel Reader Worker — proxy + extract chapter HTML (quanben5 amp etc.)
 * Does not store novel body in the repo; fetches on demand with rate limits.
 */

const ALLOWED_HOSTS = new Set([
  "big5.quanben5.com",
  "www.quanben5.com",
  "quanben5.com",
]);

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 45;
/** @type {Map<string, { count: number, reset: number }>} */
const rateBuckets = new Map();

const DEFAULT_TOC =
  "https://big5.quanben5.com/amp/n/fanrenxiuxianchuan/xiaoshuo.html";

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
          return cors(json({ ok: true, service: "novel-reader" }));
        }
        if (url.pathname === "/api/toc") {
          return cors(await handleToc(url));
        }
        if (url.pathname === "/api/chapter") {
          return cors(await handleChapter(url));
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
      { error: "請求過於頻繁，請稍後再試（約每分鐘 45 次）" },
      429,
    );
  }
  return null;
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
      // keep handbook etc. out of main list unless numbered chapter
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

  // Prefer chapters that look like 「第N章」
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
  const content = paragraphs.join("\n\n");

  const base = new URL(pageUrl);
  const prev = findNav(html, base, /上一[章頁]/);
  const next = findNav(html, base, /下一[章頁]/);
  const toc = findNav(html, base, /目錄|目录/);

  return json({
    title: decodeHtml(stripTags(title)).trim(),
    url: pageUrl,
    paragraphs,
    content,
    prev,
    next,
    toc,
  });
}

function extractParagraphs(html) {
  let block =
    matchOne(html, /<div class="wrapper">([\s\S]*?)<div class="footer/i) ||
    matchOne(html, /<div class="box_content">([\s\S]*?)<\/div>/i) ||
    matchOne(html, /<article[^>]*>([\s\S]*?)<\/article>/i) ||
    html;

  block = block.replace(/<script[\s\S]*?<\/script>/gi, "");
  block = block.replace(/<style[\s\S]*?<\/style>/gi, "");
  // quanben censored glyphs as amp-img / [img=...]
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
  if (!res.ok) {
    throw new Error(`來源站回應 ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  return decodeBuffer(buf, res.headers.get("content-type") || "");
}

function decodeBuffer(buf, contentType) {
  const bytes = new Uint8Array(buf);
  const metaCharset = (() => {
    const head = new TextDecoder("utf-8", { fatal: false }).decode(
      bytes.slice(0, 2048),
    );
    const m =
      head.match(/charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i) ||
      contentType.match(/charset\s*=\s*([a-zA-Z0-9_-]+)/i);
    return m ? m[1].toLowerCase() : "";
  })();

  const order = [];
  if (metaCharset.includes("big5") || metaCharset.includes("big-5")) {
    order.push("big5");
  } else if (metaCharset.includes("gb")) {
    order.push("gbk");
  }
  order.push("utf-8", "big5", "gbk");

  for (const enc of order) {
    try {
      const text = new TextDecoder(enc, { fatal: enc === "utf-8" }).decode(
        bytes,
      );
      if (enc !== "utf-8" || !text.includes("\uFFFD")) return text;
      if (enc === "utf-8" && (text.match(/[\u4e00-\u9fff]/g) || []).length > 20) {
        return text;
      }
    } catch {
      /* try next */
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
      "cache-control": status === 200 ? "public, max-age=120" : "no-store",
    },
  });
}

function cors(res) {
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
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
