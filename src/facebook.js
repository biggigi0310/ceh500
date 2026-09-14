import { logger } from './logger.js';

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

  /** 暫時性錯誤才值得重試:限流、伺服器忙碌、5xx。 */
  get transient() {
    const transientCodes = [1, 2, 4, 17, 32, 341, 613];
    return transientCodes.includes(this.code) || (this.httpStatus >= 500 && this.httpStatus < 600);
  }
}

/** 把 Graph API 的錯誤碼翻成人看得懂的中文,後台顯示用。 */
export function explainGraphError(err) {
  if (!(err instanceof GraphError)) return err?.message ?? '未知錯誤';
  switch (err.code) {
    case 10903:
      return '這則留言已經私訊過了(Facebook 規定每則留言只能私訊一次)';
    case 10900:
      return '留言者已關閉或無法接收粉專的 Messenger 訊息';
    case 100:
      return `參數錯誤或留言已被刪除(${err.message})`;
    case 190:
      return 'Page Access Token 已失效,請重新取得';
    case 200:
    case 10:
      return `權限不足,請確認 App 已取得 pages_messaging / pages_manage_engagement 權限(${err.message})`;
    case 4:
    case 17:
    case 32:
    case 613:
      return '已達 Facebook API 呼叫上限,稍後會自動重試';
    default:
      return err.message;
  }
}

/**
 * 一個序列化 + 最小間隔的佇列,確保所有 Graph API 呼叫不會同時打出去,
 * 降低被 Facebook 限流的機會。
 */
class RateLimitedQueue {
  #chain = Promise.resolve();
  #minInterval;
  #lastRun = 0;

  constructor(minInterval) {
    this.#minInterval = minInterval;
  }

  run(task) {
    const result = this.#chain.then(async () => {
      const wait = this.#lastRun + this.#minInterval - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        return await task();
      } finally {
        this.#lastRun = Date.now();
      }
    });
    this.#chain = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class FacebookClient {
  constructor({ accessToken, version = 'v23.0', minInterval = 1200, dryRun = false, fetchImpl = fetch }) {
    this.accessToken = accessToken;
    this.version = version;
    this.dryRun = dryRun;
    this.fetchImpl = fetchImpl;
    this.queue = new RateLimitedQueue(minInterval);
  }

  get baseUrl() {
    return `https://graph.facebook.com/${this.version}`;
  }

  async request(pathname, { method = 'GET', params = {}, body } = {}) {
    if (!this.accessToken) throw new GraphError('尚未設定 FB_PAGE_ACCESS_TOKEN', { code: 190 });

    const url = new URL(`${this.baseUrl}/${pathname.replace(/^\//, '')}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    url.searchParams.set('access_token', this.accessToken);

    return this.queue.run(() => this.#requestWithRetry(url, method, body));
  }

  async #requestWithRetry(url, method, body, attempt = 0) {
    try {
      return await this.#rawRequest(url, method, body);
    } catch (err) {
      if (err instanceof GraphError && err.transient && attempt < 3) {
        const delay = 2 ** attempt * 1000;
        logger.warn('Graph API 暫時性錯誤,準備重試', { attempt: attempt + 1, delay, code: err.code });
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.#requestWithRetry(url, method, body, attempt + 1);
      }
      throw err;
    }
  }

  async #rawRequest(url, method, body) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await this.fetchImpl(url, init);
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

  /** 對留言者發送私訊(Facebook 官方的 private reply,每則留言限一次)。 */
  async sendPrivateReply(commentId, message) {
    if (this.dryRun) {
      logger.info('[演練模式] 私訊', { commentId, message });
      return { id: 'dry-run', dryRun: true };
    }
    return this.request(`${commentId}/private_replies`, { method: 'POST', body: { message } });
  }

  /** 在該留言下面公開回覆(例如「已私訊」)。 */
  async replyToComment(commentId, message) {
    if (this.dryRun) {
      logger.info('[演練模式] 公開回覆', { commentId, message });
      return { id: 'dry-run', dryRun: true };
    }
    return this.request(`${commentId}/comments`, { method: 'POST', body: { message } });
  }

  async getPageInfo(pageId) {
    return this.request(pageId, { params: { fields: 'id,name,link' } });
  }

  async listPosts(pageId, limit = 25) {
    return this.request(`${pageId}/posts`, {
      params: { fields: 'id,message,created_time,permalink_url,full_picture', limit },
    });
  }

  /** 讓這個 App 訂閱粉專的 feed 事件,沒有這步 Webhook 不會收到留言。 */
  async subscribePage(pageId) {
    return this.request(`${pageId}/subscribed_apps`, {
      method: 'POST',
      params: { subscribed_fields: 'feed' },
    });
  }

  async listSubscribedApps(pageId) {
    return this.request(`${pageId}/subscribed_apps`, { params: { fields: 'subscribed_fields' } });
  }
}
