export class GraphError extends Error {
  constructor(message, { code, subcode, type, httpStatus, fbtraceId } = {}) {
    super(message);
    this.name = 'GraphError';
    this.code = code;
    this.subcode = subcode;
    this.type = type;
    this.httpStatus = httpStatus;
    this.fbtraceId = fbtraceId;
  }

  /** 只有暫時性錯誤(限流、伺服器忙碌)才值得重試。 */
  get transient() {
    return [1, 2, 4, 17, 32, 341, 613].includes(this.code)
      || (this.httpStatus >= 500 && this.httpStatus < 600);
  }
}

/** 把 Graph API 錯誤碼翻成女友看得懂的中文。 */
export function explainGraphError(err) {
  if (!(err instanceof GraphError)) return err?.message ?? '未知錯誤';
  switch (err.code) {
    case 10903: return '這則留言已經私訊過了(Facebook 規定每則留言只能私訊一次)';
    case 10900: return '留言者已關閉或無法接收粉專的 Messenger 訊息';
    case 100: return `參數錯誤或留言已被刪除(${err.message})`;
    case 190: return 'Page Access Token 已失效,請重新取得';
    case 10:
    case 200: return `權限不足,請確認 App 已取得 pages_messaging / pages_manage_engagement 權限(${err.message})`;
    case 4:
    case 17:
    case 32:
    case 613: return '已達 Facebook API 呼叫上限,稍後再試';
    default: return err.message;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class FacebookClient {
  constructor({ accessToken, version = 'v23.0', dryRun = false, fetchImpl = fetch }) {
    this.accessToken = accessToken;
    this.version = version;
    this.dryRun = dryRun;
    this.fetchImpl = fetchImpl;
  }

  async request(pathname, { method = 'GET', params = {}, body } = {}) {
    if (!this.accessToken) throw new GraphError('尚未設定 FB_PAGE_ACCESS_TOKEN', { code: 190 });

    const url = new URL(`https://graph.facebook.com/${this.version}/${pathname.replace(/^\//, '')}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    url.searchParams.set('access_token', this.accessToken);

    // Workers 沒有長駐程序可以排隊,所以重試次數壓低,避免佔用請求時間。
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#send(url, method, body);
      } catch (err) {
        if (err instanceof GraphError && err.transient && attempt < 2) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw err;
      }
    }
  }

  async #send(url, method, body) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await this.fetchImpl(url.toString(), init);
    } catch (err) {
      throw new GraphError(`無法連線到 Facebook:${err.message}`, { httpStatus: 503 });
    }

    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new GraphError(`Facebook 回應無法解析:${text.slice(0, 200)}`, { httpStatus: response.status });
    }

    if (!response.ok || payload.error) {
      const e = payload.error ?? {};
      throw new GraphError(e.message || `HTTP ${response.status}`, {
        code: e.code,
        subcode: e.error_subcode,
        type: e.type,
        httpStatus: response.status,
        fbtraceId: e.fbtrace_id,
      });
    }
    return payload;
  }

  /** 私訊留言者(官方 private reply,每則留言限一次)。 */
  async sendPrivateReply(commentId, message) {
    if (this.dryRun) return { id: 'dry-run', dryRun: true };
    return this.request(`${commentId}/private_replies`, { method: 'POST', body: { message } });
  }

  /** 在留言下面公開回覆(例如「已私訊」)。 */
  async replyToComment(commentId, message) {
    if (this.dryRun) return { id: 'dry-run', dryRun: true };
    return this.request(`${commentId}/comments`, { method: 'POST', body: { message } });
  }

  getPageInfo(pageId) {
    return this.request(pageId, { params: { fields: 'id,name,link' } });
  }

  listPosts(pageId, limit = 25) {
    return this.request(`${pageId}/posts`, {
      params: { fields: 'id,message,created_time,permalink_url', limit },
    });
  }

  /** 沒有訂閱 feed,webhook 就收不到留言。 */
  subscribePage(pageId) {
    return this.request(`${pageId}/subscribed_apps`, {
      method: 'POST',
      params: { subscribed_fields: 'feed' },
    });
  }

  listSubscribedApps(pageId) {
    return this.request(`${pageId}/subscribed_apps`, { params: { fields: 'subscribed_fields' } });
  }
}
