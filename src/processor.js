import { logger } from './logger.js';
import { explainGraphError } from './facebook.js';

/** 樣板變數:{{name}} {{link}} {{comment}} {{post_id}} */
export function renderTemplate(template, vars) {
  if (!template) return '';
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

export function matchesKeywords(rule, message) {
  if (rule.keywordMode !== 'any') return true;
  if (!rule.keywords?.length) return true;
  const text = (message ?? '').toLowerCase();
  return rule.keywords.some((keyword) => text.includes(String(keyword).toLowerCase().trim()));
}

/**
 * 找出要套用的規則:先找綁定該貼文的,找不到再用萬用規則(postId 為 "*")。
 */
export function findRule(rules, postId) {
  const enabled = rules.filter((rule) => rule.enabled);
  return (
    enabled.find((rule) => rule.postId === postId) ??
    enabled.find((rule) => rule.postId === '*') ??
    null
  );
}

/** Facebook 的 comment_id 形如 "<postId>_<commentId>";頂層留言的 parent_id 等於貼文 ID。 */
export function isTopLevelComment(change) {
  if (!change.parent_id) return true;
  return change.parent_id === change.post_id;
}

/**
 * 判斷這筆 webhook 變更是否為「有人在貼文下新增留言」。
 * 回傳 { ok: true } 或 { ok: false, reason }。
 */
export function shouldHandle(change, { pageId, settings }) {
  if (change.item !== 'comment') return { ok: false, reason: `不是留言事件(${change.item})` };
  if (change.verb !== 'add') return { ok: false, reason: `不是新增留言(${change.verb})` };
  if (settings.skipOwnComments && pageId && change.from?.id === pageId) {
    return { ok: false, reason: '這是粉專自己的留言' };
  }
  if (settings.skipNestedComments && !isTopLevelComment(change)) {
    return { ok: false, reason: '這是留言的回覆,不是主留言' };
  }
  return { ok: true };
}

export function createProcessor({ fb, store }) {
  /** 處理整包 webhook payload。 */
  async function handleWebhookPayload(payload, { pageId }) {
    const results = [];
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'feed') continue;
        results.push(await handleChange(change.value ?? {}, { pageId: pageId || entry.id }));
      }
    }
    return results;
  }

  async function handleChange(change, { pageId }) {
    const settings = store.settings;
    const commentId = change.comment_id;

    if (!settings.enabled) return skip(commentId, '自動回覆功能目前為關閉');

    const gate = shouldHandle(change, { pageId, settings });
    if (!gate.ok) return skip(commentId, gate.reason);

    if (!commentId) return skip(commentId, '事件缺少 comment_id');
    if (store.isProcessed(commentId)) return skip(commentId, '這則留言已處理過');

    const rule = findRule(store.rules, change.post_id);
    if (!rule) return skip(commentId, '這篇貼文沒有對應的自動回覆設定');
    if (!matchesKeywords(rule, change.message)) {
      return skip(commentId, `留言不含設定的關鍵字(${rule.keywords.join('、')})`);
    }

    // 先佔位,避免 Facebook 重送 webhook 時重複私訊。
    store.markProcessed(commentId, { status: 'processing', ruleId: rule.id });

    const vars = {
      name: change.from?.name ?? '您好',
      link: rule.link ?? '',
      comment: change.message ?? '',
      post_id: change.post_id ?? '',
    };

    const dmMessage = renderTemplate(rule.dmTemplate, vars).trim();
    if (!dmMessage) {
      return fail(commentId, rule, change, '私訊內容是空的,請到後台設定');
    }

    try {
      const dmResult = await fb.sendPrivateReply(commentId, dmMessage);
      logger.info('已私訊留言者', { commentId, ruleId: rule.id });

      let publicReplyId = null;
      let publicReplyError = null;
      const publicMessage = renderTemplate(rule.publicReplyTemplate, vars).trim();

      if (store.settings.publicReplyEnabled && publicMessage) {
        try {
          const replyResult = await fb.replyToComment(commentId, publicMessage);
          publicReplyId = replyResult?.id ?? null;
        } catch (err) {
          // 私訊已經成功了,公開回覆失敗不該讓整件事算失敗。
          publicReplyError = explainGraphError(err);
          logger.warn('公開回覆失敗', { commentId, error: publicReplyError });
        }
      }

      store.markProcessed(commentId, { status: 'sent', ruleId: rule.id, messageId: dmResult?.id ?? null });
      store.addLog({
        status: 'sent',
        commentId,
        postId: change.post_id,
        ruleId: rule.id,
        ruleName: rule.name,
        from: vars.name,
        comment: vars.comment,
        dmMessage,
        publicReply: publicReplyId ? publicMessage : null,
        publicReplyError,
      });
      return { status: 'sent', commentId, publicReplyError };
    } catch (err) {
      return fail(commentId, rule, change, explainGraphError(err), err);
    }
  }

  function skip(commentId, reason) {
    logger.debug('略過留言', { commentId, reason });
    return { status: 'skipped', commentId, reason };
  }

  function fail(commentId, rule, change, reason, err) {
    logger.error('自動回覆失敗', { commentId, reason });
    store.markProcessed(commentId, { status: 'failed', ruleId: rule.id, error: reason });
    store.addLog({
      status: 'failed',
      commentId,
      postId: change.post_id,
      ruleId: rule.id,
      ruleName: rule.name,
      from: change.from?.name ?? '',
      comment: change.message ?? '',
      error: reason,
      errorCode: err?.code ?? null,
    });
    return { status: 'failed', commentId, reason };
  }

  return { handleWebhookPayload, handleChange };
}
