# 粉專留言自動私訊物件連結

有人在粉絲專頁貼文下留言 → 自動私訊物件連結給他 → 並在他的留言下回覆「已私訊」。
私訊內容、公開回覆內容、觸發關鍵字都在網頁後台設定,不用改程式。

跑在 **Cloudflare Workers + D1**:免費額度內就夠用、不會休眠、不用顧主機。

---

## ⚠️ 先讀這段:能做到什麼、做不到什麼

| 情境 | 可以自動化嗎 |
| --- | --- |
| **粉絲專頁(Page)** 的貼文留言 | ✅ 可以,本專案就是做這個 |
| **個人臉書帳號** 的貼文留言 | ❌ 不行,Facebook 沒有開放 API |
| **社團** 的留言 | ❌ 不行,Groups API 已關閉 |

**如果現在是用個人帳號發物件,必須先改用粉絲專頁發文,這套才有辦法運作。**
瀏覽器外掛那種「自動點擊」的做法違反 Facebook 使用條款、帳號有停權風險,所以這裡不走那條路。

還有三個 Facebook 的硬性限制,不是程式能繞過的:

1. **每則留言只能私訊一次**(官方 `private_replies` 的規定)。
2. 留言後 **7 天內**才能私訊。
3. 對方若關閉粉專訊息權限,私訊會失敗 — 這時系統**不會**在留言下面寫「已私訊」,而是記成失敗,方便手動處理。

---

## 部署步驟

### 1. 裝工具、登入 Cloudflare

```bash
npm install
npx wrangler login
```

### 2. 建資料庫

```bash
npm run db:create      # 會印出一段 database_id
```

把印出來的 `database_id` 貼進 `wrangler.toml` 的 `[[d1_databases]]` 區塊,然後建表:

```bash
npm run db:init
```

### 3. 設定機密資料

```bash
npx wrangler secret put FB_APP_SECRET          # Facebook App 的 App Secret
npx wrangler secret put FB_VERIFY_TOKEN        # 自己取一組字串,等下填 Webhook 要用同一組
npx wrangler secret put FB_PAGE_ACCESS_TOKEN   # 粉專的 Page Access Token
npx wrangler secret put FB_PAGE_ID             # 粉專 ID
npx wrangler secret put ADMIN_PASSWORD         # 後台登入密碼
npx wrangler secret put SESSION_SECRET         # 隨機字串,可用 openssl rand -hex 32 產生
```

### 4. 部署

```bash
npm run deploy
```

部署完會印出網址,例如 `https://fb-comment-autoreply.你的帳號.workers.dev`。

- **後台(女友用的)** → 這個網址,輸入 `ADMIN_PASSWORD` 登入
- **Webhook(Facebook 用的)** → 同一個網址後面加 `/webhook`

手機瀏覽器開後台網址可以「加入主畫面」,用起來就像 App。想換成自己的網域也可以,在 Cloudflare 後台綁 Custom Domain 即可,程式不用改。

---

## Facebook 設定(只需做一次)

1. **建立粉絲專頁**,物件貼文都發在這裡。
2. 到 [developers.facebook.com](https://developers.facebook.com) → 建立應用程式 → 類型選「**商業**」。
3. 加入產品「**Messenger**」與「**Webhooks**」。
4. 在 Messenger 設定頁把粉專連到這個 App,產生 **Page Access Token**。
   預設 token 會過期,建議用[存取權杖偵錯工具](https://developers.facebook.com/tools/debug/accesstoken/)換成**永久有效**的版本。
5. 需要的權限:`pages_messaging`、`pages_manage_engagement`、`pages_read_engagement`、`pages_show_list`。
   **開發模式下**,只要女友的帳號是這個 App 的管理員或測試者,不用送審就能用在自己的粉專。
6. Webhooks 設定:
   - 回呼網址:`https://你的-workers-網址/webhook`
   - 驗證權杖:填上面設定的 `FB_VERIFY_TOKEN`
   - 訂閱欄位:勾 **`feed`**
7. 打開後台 →「系統狀態」→ 按「**訂閱粉專留言事件**」,再按「執行檢查」確認一切正常。

---

## 先試跑再上線

`wrangler.toml` 裡的 `DRY_RUN` 預設是 `"true"`:**所有判斷邏輯照跑、紀錄照寫,但不會真的送出私訊**。

建議流程:

1. 先在後台建好一則規則。
2. 女友自己去那篇貼文留一則測試留言。
3. 看後台「回覆紀錄」有沒有抓到、內容對不對。
4. 確認沒問題後,把 `DRY_RUN` 改成 `"false"`,重新 `npm run deploy`。

---

## 後台怎麼用

### 物件設定
每篇要自動回覆的貼文建一則設定:

- **貼文 ID** — 在「系統狀態 → 最近的貼文 → 用這篇」可以直接帶入。填 `*` 代表**所有貼文**都套用。
- **物件連結** — 這篇要發的物件網址。
- **私訊內容** — 可用變數:`{{name}}` 留言者名字、`{{link}}` 物件連結、`{{comment}}` 對方留言內容。
- **留言下的公開回覆** — 例如「已私訊給您囉」。留空白就不公開回覆。
- **觸發條件** — 「所有留言都私訊」或「只有留言含關鍵字才私訊」(例如只回覆含「詳細」「+1」「想看」的留言,避免對純讚美留言洗版)。

按「預覽」可以先看到實際送出去長什麼樣再存檔。

### 回覆紀錄
每一筆私訊成功/失敗、對方是誰、留言內容、失敗原因都看得到。

### 系統狀態
連線檢查、訂閱粉專、全站開關(要不要公開回覆、要不要忽略子留言)。
右上角有**總開關**,要暫停自動回覆時直接關掉。

---

## 設計上的安全與正確性考量

- **Webhook 簽章驗證** — 每個請求都用 App Secret 驗 `X-Hub-Signature-256`,驗不過直接 403,避免有人偽造留言事件讓系統亂發訊息。
- **去重靠資料庫主鍵** — `processed_comments.comment_id` 是主鍵,用 `INSERT OR IGNORE` 搶佔;就算 Facebook 同時重送多筆,也只有一個請求搶得到,不會重複私訊。
- **暫時性錯誤會放掉佔位** — 遇到限流這類暫時性失敗時刪除佔位紀錄,讓 Facebook 重送 webhook 時還能補送;永久性錯誤(例如對方關閉訊息)才記為失敗。
- **私訊失敗就不寫「已私訊」** — 避免留言區出現「已私訊」但對方其實沒收到。公開回覆失敗則不影響私訊成功的判定。
- **後台需登入** — 密碼用不隨內容提早結束的方式比對,session 是 HMAC 簽章的 httpOnly + Secure cookie。
- **紀錄排序用自動遞增序號** — 不用時間戳,避免同一毫秒寫入兩筆時順序錯亂。

## 專案結構

```
src/
  index.js            Worker 進入點:路由 + 設定讀取
  store.js            D1 資料存取
  facebook.js         Graph API 客戶端(重試、錯誤中文化)
  webhook.js          Webhook 簽章驗證與驗證握手
  admin.js            後台 API
  auth.js             登入 session
  core/
    processor.js      核心邏輯:留言 → 比對規則 → 私訊 → 公開回覆
    templates.js      樣板置換、關鍵字比對、事件過濾
  lib/
    crypto.js         WebCrypto 包裝(HMAC、固定時間比對)
    router.js         極簡路由器
public/               後台網頁(Workers 靜態資源)
schema.sql            D1 資料表定義
test/                 測試(npm test)
```

## 測試

```bash
npm test          # 45 個測試,含用 node:sqlite 模擬 D1 跑真實 SQL
npm run dev       # 本機用真的 Workers 執行環境跑(需先 npm run db:init:local)
npm run tail      # 看線上的即時 log
```
