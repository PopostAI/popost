/** Maps a platform error envelope code to a user-facing message (port of `describe_error` in popost_api.py). */
import { VERSION } from '../version';
import { isRecord } from './base';

export const DEFAULT_KEY_ENV = 'POPOST_API_KEY';
/** The key page of the official service; `PopostClient` swaps in the page of the origin it talks to. */
export const DEFAULT_KEY_PAGE = 'https://popost.ai/account/api-keys';

/** Python `"%d"` for whole numbers, `"%s"` otherwise; booleans and missing values print the fallback. */
export const num = (value: unknown, fallback = '未知'): string => {
  if (typeof value === 'boolean' || value === null || value === undefined) return fallback;
  if (typeof value === 'number') return String(value);
  return String(value).slice(0, 40);
};

const issueLines = (details: Record<string, unknown>): string => {
  const issues = Array.isArray(details.issues) ? details.issues : [];
  const parts: string[] = [];
  for (const issue of issues.slice(0, 8)) {
    if (!isRecord(issue)) continue;
    const path = Array.isArray(issue.path) ? issue.path.map(String).join('.') : issue.path;
    parts.push(`${String(path || '-').slice(0, 80)}: ${String(issue.message || '').slice(0, 120)}`);
  }
  return parts.length ? `：${parts.join('；')}` : '';
};

/** `details.issues[].code` of a refused deck, comma separated and bounded. */
const deckIssueCodes = (details: Record<string, unknown>): string => {
  const issues = Array.isArray(details.issues) ? details.issues : [];
  const codes = issues.slice(0, 8).flatMap((issue) => (isRecord(issue) && typeof issue.code === 'string' ? [issue.code.slice(0, 60)] : []));
  return codes.length ? codes.join(', ') : '未列出原因';
};

const message = (code: string | undefined, d: Record<string, unknown>, keyEnv: string): string => {
  switch (code) {
    case 'UNAUTHORIZED':
      return `账户连接已失效。请运行 popost auth login 重新连接，可在 ${DEFAULT_KEY_PAGE} 管理连接。使用 ${keyEnv} 的开发者请更新宿主密钥或在自己的终端运行 popost auth set --prompt`;
    case 'FORBIDDEN':
      return 'popost.ai 拒绝访问：当前账户无权执行该操作';
    case 'NOT_FOUND':
      return 'popost.ai 找不到请求的资源（检查 baseUrl、模型或对象 id）';
    case 'LINK_UNSUPPORTED':
      return 'popost.ai 不支持这个链接：只支持 X、Instagram、TikTok、抖音、小红书的帖子链接（未建任务，未扣积分）';
    case 'LINK_IMPORT_NOT_FOUND':
      return 'popost.ai 找不到这个解析任务（id 有误，或不是当前账户的任务）';
    case 'INVALID_REQUEST':
      return `popost.ai 判定请求参数不合法，未执行${issueLines(d)}`;
    case 'INSUFFICIENT_CREDITS':
      return `积分不足：本次需要 ${num(d.required)} 积分，当前余额 ${num(d.balance)}。这一步需要 popost 积分：可用 popost account 查看账户与购买入口，或选择本地参考、自带 Key / Agent 生图后重新报价（未扣费；popost account 可查余额和购买页面）`;
    case 'CREDIT_LIMIT_EXCEEDED':
      return `平台计价 ${num(d.required)} 积分超过已确认上限 ${num(d.maxCredits)}（余额 ${num(d.balance)}），已拒绝且未扣费；请重新报价并确认新价格`;
    case 'RATE_LIMITED': {
      const wait = d.retryAfterSeconds;
      return wait !== undefined && wait !== null ? `请求过于频繁，被 popost.ai 限流；请 ${num(wait)} 秒后再试` : '请求过于频繁，被 popost.ai 限流；请稍后再试';
    }
    case 'DECK_CONFLICT':
      return `云端作品在上次同步后被网页端修改过（云端版本 ${num(d.currentVersion)}），未覆盖；在编辑器里选择“打开”查看，或确认覆盖后加 --force 重新同步`;
    case 'DECK_INVALID':
      return `云端拒绝了这份作品（${deckIssueCodes(d)}），未同步；请按提示修正页面后重试`;
    case 'STORAGE_FULL':
      return 'popost.ai 云端存储空间已满，未同步；请清理素材或升级会员后重试';
    case 'CLI_VERSION_TOO_OLD':
      return `当前 popost Skill 版本 ${VERSION} 过旧（平台要求 ≥ ${num(d.minVersion)}），请更新 popost Skill 后重试`;
    case 'CONTENT_REJECTED':
      return '内容未通过 popost.ai 审核，请调整提示词或参考图后重新报价';
    case 'UPSTREAM_ERROR':
      return 'popost.ai 生成服务暂时失败，请稍后重试';
    case 'SERVICE_UNAVAILABLE':
      return 'popost.ai 服务暂时不可用，请稍后重试';
    case 'TIMEOUT':
      return 'popost.ai 处理超时';
    case 'NOT_IMPLEMENTED':
      return 'popost.ai 尚未开放该功能';
    case 'INTERNAL_ERROR':
      return 'popost.ai 内部错误';
    default:
      return 'popost.ai 返回错误';
  }
};

/** Only known fields are read; the server's own text is appended, truncated. */
export const describeError = (code: string | undefined, serverMessage?: unknown, details?: unknown, keyEnv = DEFAULT_KEY_ENV): string => {
  let text = message(code, isRecord(details) ? details : {}, keyEnv);
  if (serverMessage) text += `（平台说明：${String(serverMessage).trim().slice(0, 200)}）`;
  return `${text} [${code || 'UNKNOWN'}]`;
};
