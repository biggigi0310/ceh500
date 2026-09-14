import { explainGraphError } from '../facebook.js';
import { matchesKeywords, renderTemplate, shouldHandle } from './templates.js';

export function createProcessor({ fb, store }) {
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
    const settings = await store.getSettings();
    const commentId = change.comment_id;

    if (!settings.enabled) return skip(commentId, '自動回覆功能目前為關閉');

    const gate = shouldHandle(change, { pageId, settings });
    if (!gate.ok) return skip(commentId, gate.reason);
    if (!commentId) return skip(commentId, '事件缺少 comment_id');

    const rule = await store.findRuleForPost(change.post_id);
    if (!rule) return skip(commentId, '這篇貼文沒有對應的自動回覆設定');
    if (!matchesKeywords(rule, change.message)) {
      return skip(commentId, `留言不含設定的關鍵字(${rule.keywords.join('、')})`);
    }

    // 搶下這則留言;搶不到代表別的請求已經在處理了(Facebook 會重送 webhook)。
    if (!(await store.claimComment(commentId, rule.id))) {
      return skip(commentId, '這則留言已處理過');
    }

    const vars = {
      name: change.from?.name ?? '您好',
      link: rule.link ?? '',
      comment: change.message ?? '',
      post_id: change.post_id ?? '',
    };

    const dmMessage = renderTemplate(rule.dmTemplate, vars).trim();
    if (!dmMessage) return fail(commentId, rule, change, '私訊內容是空的,請到後台設定');

    let dmResult;
    try {
      dmResult = await fb.sendPrivateReply(commentId, dmMessage);
    } catch (err) {
      const reason = explainGraphError(err);
      // 暫時性失敗就放掉佔位,讓 Facebook 重送 webhook 時還有機會補送。
      if (err?.transient) {
        await store.releaseComment(commentId);
        await store.addLog({
          status: 'failed', commentId, postId: change.post_id, ruleId: rule.id, ruleName: rule.name,
          author: vars.name, comment: vars.comment, error: `${reason}(稍後會由 Facebook 重送)`,
        });
        return { status: 'retryable', commentId, reason };
      }
      return fail(commentId, rule, change, reason);
    }

    let publicReplyId = null;
    let publicReplyError = null;
    const publicMessage = renderTemplate(rule.publicReplyTemplate, vars).trim();

    if (settings.publicReplyEnabled && publicMessage) {
      try {
        publicReplyId = (await fb.replyToComment(commentId, publicMessage))?.id ?? null;
      } catch (err) {
        // 私訊已經送出去了,公開回覆失敗不該讓整件事算失敗。
        publicReplyError = explainGraphError(err);
      }
    }

    await store.markProcessed(commentId, { status: 'sent', ruleId: rule.id });
    await store.addLog({
      status: 'sent',
      commentId,
      postId: change.post_id,
      ruleId: rule.id,
      ruleName: rule.name,
      author: vars.name,
      comment: vars.comment,
      dmMessage,
      publicReply: publicReplyId ? publicMessage : null,
      publicReplyError,
    });
    return { status: 'sent', commentId, messageId: dmResult?.id ?? null, publicReplyError };
  }

  function skip(commentId, reason) {
    return { status: 'skipped', commentId, reason };
  }

  async function fail(commentId, rule, change, reason) {
    await store.markProcessed(commentId, { status: 'failed', ruleId: rule.id, error: reason });
    await store.addLog({
      status: 'failed',
      commentId,
      postId: change.post_id,
      ruleId: rule.id,
      ruleName: rule.name,
      author: change.from?.name ?? '',
      comment: change.message ?? '',
      error: reason,
    });
    return { status: 'failed', commentId, reason };
  }

  return { handleWebhookPayload, handleChange };
}
