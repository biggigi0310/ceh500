// 極簡路由器:Workers 上不用 Express,這樣就夠了,也少一個相依套件。

export class Router {
  #routes = [];
  #middleware = [];

  use(prefix, handler) {
    this.#middleware.push({ prefix, handler });
    return this;
  }

  #add(method, pattern, handler) {
    const keys = [];
    const regexSource = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:(\w+)/g, (match, key) => {
        keys.push(key);
        return '([^/]+)';
      });
    this.#routes.push({ method, regex: new RegExp(`^${regexSource}$`), keys, handler });
    return this;
  }

  get(pattern, handler) { return this.#add('GET', pattern, handler); }
  post(pattern, handler) { return this.#add('POST', pattern, handler); }
  put(pattern, handler) { return this.#add('PUT', pattern, handler); }
  delete(pattern, handler) { return this.#add('DELETE', pattern, handler); }

  /** 找不到路由時回傳 null,讓呼叫端決定要不要改送靜態檔案。 */
  async handle(request, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    for (const route of this.#routes) {
      if (route.method !== request.method) continue;
      const match = route.regex.exec(pathname);
      if (!match) continue;

      const params = Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
      for (const { prefix, handler } of this.#middleware) {
        if (!pathname.startsWith(prefix)) continue;
        const short = await handler(request, { ...ctx, params, url });
        if (short) return short;
      }
      return route.handler(request, { ...ctx, params, url });
    }
    return null;
  }
}

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers ?? {}) },
  });
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
