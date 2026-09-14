# 粉專留言自動私訊物件連結

有人在粉絲專頁貼文下留言 → 自動私訊物件連結給他 → 並在他的留言下回覆「已私訊」。
私訊內容、公開回覆內容、觸發關鍵字都可以在網頁後台自己設定,不用改程式。

---

## ⚠️ 先讀這段:能做到什麼、做不到什麼

| 情境 | 可以自動化嗎 |
| --- | --- |
| **粉絲專頁(Page)** 的貼文留言 | ✅ 可以,本專案就是做這個 |
| **個人臉書帳號** 的貼文留言 | ❌ 不行,Facebook 沒有開放 API |
| **社團(社團貼文)** 的留言 | ❌ 不行,2024 年起 Groups API 已關閉 |

**如果女友目前是用個人帳號發物件,必須先改用粉絲專頁發文,這套才有辦法運作。**
坊間那種「掛在瀏覽器上自動點」的外掛是模擬操作、違反 Facebook 使用條款,帳號有被停權風險,所以這裡不走那條路。

還有三個 Facebook 的硬性限制,不是程式能繞過的:

1. **每則留言只能私訊一次**(官方 `private_replies` 的規定),重複觸發會被擋掉。
2. 留言後 **7 天內**才能私訊。
3. 對方如果把粉專的訊息權限關掉,私訊會失敗 — 這時系統**不會**在留言下面寫「已私訊」,而是記成失敗,方便手動處理。

---

## 快速開始

```bash
npm install
cp .env.example .env     # 然後照下面說明填內容
npm run subscribe        # 讓粉專開始把留言事件送過來(設定好 .env 後執行一次)
npm start                # 開 http://localhost:3000 就是後台
```

第一次建議先把 `.env` 的 `DRY_RUN=true` 打開:所有判斷邏輯照跑、紀錄照寫,但**不會真的送出私訊**,確認內容沒問題再關掉。

---

## Facebook 設定步驟(只需做一次)

1. **建立粉絲專頁**,把物件貼文都發在這裡。
2. 到 [developers.facebook.com](https://developers.facebook.com) → 建立應用程式 → 類型選「**商業**」。
3. 加入產品「**Messenger**」與「**Webhooks**」。
4. 在 Messenger 設定頁把粉專連結到這個 App,產生 **Page Access Token**,填進 `.env` 的 `FB_PAGE_ACCESS_TOKEN`。
   - 預設的 token 會過期,建議用[存取權杖偵錯工具](https://developers.facebook.com/tools/debug/accesstoken/)換成**永久有效**的版本。
5. 需要的權限:`pages_messaging`(私訊)、`pages_manage_engagement`(公開回覆)、`pages_read_engagement`、`pages_show_list`。
   - **開發模式下**,只要女友的帳號是這個 App 的管理員/測試者,不用送審就能用在自己的粉專。要給別人用才需要送審。
6. **把服務放到有 HTTPS 的網址上**(Facebook 只接受 https)。自架可用 [ngrok](https://ngrok.com/) 或 Cloudflare Tunnel;也可以部署到 Render / Railway / Fly.io。
7. Webhooks 設定:
   - 回呼網址:`https://你的網域/webhook`
   - 驗證權杖:填 `.env` 裡的 `FB_VERIFY_TOKEN`
   - 訂閱欄位:勾 **`feed`**
8. 執行 `npm run subscribe`,把粉專訂閱到這個 App。之後在後台「系統狀態 → 執行檢查」可以確認有沒有成功。

---

## 後台怎麼用

開 `http://你的網址/`,用 `.env` 裡的 `ADMIN_PASSWORD` 登入。

### 物件設定
每篇要自動回覆的貼文建一則設定:

- **貼文 ID** — 在「系統狀態 → 最近的貼文 → 用這篇」可以直接帶入。填 `*` 代表**所有貼文**都套用。
- **物件連結** — 這一篇要發的物件網址。
- **私訊內容** — 可用變數:
  - `{{name}}` 留言者的名字
  - `{{link}}` 上面填的物件連結
  - `{{comment}}` 對方留言的內容
- **留言下的公開回覆** — 例如「已私訊給您囉」。留空白就不公開回覆。
- **觸發條件** — 可選「所有留言都私訊」或「只有留言含關鍵字才私訊」(例如只回覆含「詳細」「+1」「想看」的留言,避免對純按讚留言洗版)。

按「預覽」可以先看到實際送出去長什麼樣子再存檔。

### 回覆紀錄
每一筆私訊成功/失敗、對方是誰、留言內容、失敗原因都看得到。

### 系統狀態
- 連線檢查:確認 Token 有效、粉專有訂閱 `feed`。
- 全站開關:公開回覆要不要開、要不要忽略子留言、忽略粉專自己的留言。

右上角有一個**總開關**,要暫停自動回覆時直接關掉就好。

---

## 設計上的安全考量

- **Webhook 簽章驗證** — 每個進來的請求都用 App Secret 驗 `X-Hub-Signature-256`,驗不過直接 403,避免有人偽造留言事件讓系統亂發訊息。
- **去重** — 每則留言的 ID 都會被記下來,Facebook 重送 webhook 也不會重複私訊。處理前就先佔位,避免同時收到兩次而發兩則。
- **私訊失敗就不寫「已私訊」** — 避免留言區出現「已私訊」但對方其實沒收到。
- **限流保護** — 所有 Graph API 呼叫排隊送出並保持最小間隔,暫時性錯誤(限流、5xx)會自動重試三次。
- **後台需登入**,密碼用 constant-time 比對,session 用 HMAC 簽章的 httpOnly cookie。

## 專案結構

```
src/
  index.js            服務進入點
  config.js           環境變數讀取與檢查
  facebook.js         Graph API 客戶端(限流、重試、錯誤中文化)
  webhook.js          Webhook 路由與簽章驗證
  processor.js        核心邏輯:留言 → 比對規則 → 私訊 → 公開回覆
  store.js            JSON 檔資料保存(設定、規則、紀錄、去重)
  admin/              後台 API 與網頁介面
scripts/subscribe.js  把粉專訂閱到 App
test/                 單元測試(npm test)
```

資料存在 `data/store.json`(單一 JSON 檔,方便備份)。部署到會重置檔案系統的平台時,記得把這個檔案放在永久磁碟上。

## 測試

```bash
npm test
```
