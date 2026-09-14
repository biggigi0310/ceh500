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

/** Facebook 的頂層留言,parent_id 會等於貼文 ID。 */
export function isTopLevelComment(change) {
  if (!change.parent_id) return true;
  return change.parent_id === change.post_id;
}

/** 這筆 webhook 變更是不是「有人在貼文下新增留言」。 */
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
