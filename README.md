## 線上

- App: https://novel-reader.tylerwang26.workers.dev
- Repo: https://github.com/tylerwang26/novel-reader

# 墨聲 · novel-reader

貼上小說目錄網址，用語音或文字指令朗讀正文。預設支援全本小說網《凡人修仙傳》AMP 目錄。

## 功能

- 代理抓取目錄／章節 HTML，抽取正文（處理 UTF-8／Big5／GBK）
- 章節列表、上一章／下一章、暫停／繼續、語速
- 正文搜尋並跳轉，可接著朗讀
- 語音命令（Web Speech API，`zh-TW`）與文字指令 fallback
- 瀏覽器 TTS 優先選 `zh-TW` 女聲

## 本地開發

```bash
npm install
npm run dev
```

開啟終端機顯示的 `http://127.0.0.1:8787`。

## 部署（Cloudflare Workers）

```bash
npx wrangler login   # 或設定 CLOUDFLARE_API_TOKEN
npm run deploy
```

Workers 會同時提供靜態前端與 `/api/toc`、`/api/chapter`。

## 語音怎麼用（凡人修仙傳）

1. 開啟部署網址（或本地 `npm run dev`）
2. 確認目錄為  
   `https://big5.quanben5.com/amp/n/fanrenxiuxianchuan/xiaoshuo.html`
3. 按「載入目錄」
4. 點「語音」後說：**「從第三十章開始唸」**（也可用阿拉伯數字）
5. 或在文字指令框輸入相同句子後按「執行」
6. 可用「暫停」「繼續」「下一章」「上一章」「開始朗讀」

> Chrome／Edge 桌面版對 Web Speech 支援較佳；需允許麥克風。無辨識時請用文字指令。

## TTS 取捨

| 方案 | 優點 | 缺點 |
| --- | --- | --- |
| **瀏覽器 Speech Synthesis（預設）** | 零金鑰、低延遲、可離線；前端會偏好 `zh-TW` 女聲（如 Microsoft HsiaoChen、Google 台灣女聲、Apple Mei-Jia） | 各裝置聲音品質不一；部分 Linux／無中文語音包環境可能落到其他 `zh` 聲線 |
| **Azure Speech（zh-TW，女聲如 HsiaoChenNeural）** | 台灣口音穩定、品質高 | 需 Azure 金鑰與後端／Workers 串流，成本與隱私考量較大 |
| **Google Cloud TTS（cmn-TW）** | 台灣國語選項清楚 | 同樣需 API 金鑰與計費 |

目前採 **瀏覽器端優先**，不需雲端金鑰即可部署。若要升級雲端 TTS，建議 Azure `zh-TW-HsiaoChenNeural`。

## API

- `GET /api/toc?url=` — 目錄與章節列表
- `GET /api/chapter?url=` — 單章正文
- 同源代理；白名單主機；每 IP 約每分鐘 45 次

**注意：** 不會把小說正文 commit 進 repo；僅即時抓取。

## 授權與來源

閱讀內容來自使用者指定的公開網頁；請遵守來源站使用條款與合理使用頻率。
