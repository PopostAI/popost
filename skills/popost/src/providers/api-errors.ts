/** Maps a platform error envelope code to a user-facing message (port of `describe_error` in popost_api.py). */
import { msg } from '../i18n';
import { VERSION } from '../version';
import { isRecord } from './base';

export const DEFAULT_KEY_ENV = 'POPOST_API_KEY';
/** The key page of the official service; `PopostClient` swaps in the page of the origin it talks to. */
export const DEFAULT_KEY_PAGE = 'https://popost.ai/account/api-keys';

/** Python `"%d"` for whole numbers, `"%s"` otherwise; booleans and missing values print the fallback ("unknown"). */
export const num = (value: unknown, fallback = msg('unknown', '未知')): string => {
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
  if (!parts.length) return '';
  return msg(`: ${parts.join('; ')}`, `：${parts.join('；')}`);
};

/** `details.issues[].code` of a refused deck, comma separated and bounded. */
const deckIssueCodes = (details: Record<string, unknown>): string => {
  const issues = Array.isArray(details.issues) ? details.issues : [];
  const codes = issues.slice(0, 8).flatMap((issue) => (isRecord(issue) && typeof issue.code === 'string' ? [issue.code.slice(0, 60)] : []));
  return codes.length ? codes.join(', ') : msg('no reason given', '未列出原因');
};

const message = (code: string | undefined, d: Record<string, unknown>, keyEnv: string): string => {
  switch (code) {
    case 'UNAUTHORIZED':
      return msg(
        `The account connection is no longer valid. Run popost auth login to reconnect; connections are managed at ${DEFAULT_KEY_PAGE}. Developers who use ${keyEnv}: update the key in the host, or run popost auth set --prompt in your own terminal`,
        `账户连接已失效。请运行 popost auth login 重新连接，可在 ${DEFAULT_KEY_PAGE} 管理连接。使用 ${keyEnv} 的开发者请更新宿主密钥或在自己的终端运行 popost auth set --prompt`,
      );
    case 'FORBIDDEN':
      return msg('popost.ai refused access: this account is not allowed to do that', 'popost.ai 拒绝访问：当前账户无权执行该操作');
    case 'NOT_FOUND':
      return msg('popost.ai cannot find the requested resource (check the baseUrl, the model or the object id)', 'popost.ai 找不到请求的资源（检查 baseUrl、模型或对象 id）');
    case 'LINK_UNSUPPORTED':
      return msg(
        'popost.ai does not support this link: only post links from X, Instagram, TikTok, Douyin and Xiaohongshu are supported (no task was created, no credits were charged)',
        'popost.ai 不支持这个链接：只支持 X、Instagram、TikTok、抖音、小红书的帖子链接（未建任务，未扣积分）',
      );
    case 'LINK_IMPORT_NOT_FOUND':
      return msg('popost.ai cannot find this parsing task (the id is wrong, or the task belongs to another account)', 'popost.ai 找不到这个解析任务（id 有误，或不是当前账户的任务）');
    case 'INVALID_REQUEST':
      return msg(`popost.ai rejected the request parameters and did nothing${issueLines(d)}`, `popost.ai 判定请求参数不合法，未执行${issueLines(d)}`);
    case 'INSUFFICIENT_CREDITS':
      return msg(
        `Not enough credits: this step needs ${num(d.required)} credits and the balance is ${num(d.balance)}. Nothing was charged. It is paid with popost credits: popost account shows the balance and where to buy more; or choose local references, your own API key or the agent's image tool, and quote again`,
        `积分不足：本次需要 ${num(d.required)} 积分，当前余额 ${num(d.balance)}。这一步需要 popost 积分：可用 popost account 查看账户与购买入口，或选择本地参考、自带 Key / Agent 生图后重新报价（未扣费；popost account 可查余额和购买页面）`,
      );
    case 'CREDIT_LIMIT_EXCEEDED':
      return msg(
        `The platform price of ${num(d.required)} credits is above the confirmed limit of ${num(d.maxCredits)} (balance ${num(d.balance)}); refused, nothing was charged. Quote again and confirm the new price`,
        `平台计价 ${num(d.required)} 积分超过已确认上限 ${num(d.maxCredits)}（余额 ${num(d.balance)}），已拒绝且未扣费；请重新报价并确认新价格`,
      );
    case 'RATE_LIMITED': {
      const wait = d.retryAfterSeconds;
      return wait !== undefined && wait !== null
        ? msg(`Too many requests: popost.ai is rate limiting; try again in ${num(wait)} seconds`, `请求过于频繁，被 popost.ai 限流；请 ${num(wait)} 秒后再试`)
        : msg('Too many requests: popost.ai is rate limiting; try again later', '请求过于频繁，被 popost.ai 限流；请稍后再试');
    }
    case 'DECK_CONFLICT':
      return msg(
        `The cloud copy was changed on the website after the last sync (cloud version ${num(d.currentVersion)}) and was not overwritten; choose "Open" in the editor to see it, or, to overwrite it, sync again with --force`,
        `云端作品在上次同步后被网页端修改过（云端版本 ${num(d.currentVersion)}），未覆盖；在编辑器里选择“打开”查看，或确认覆盖后加 --force 重新同步`,
      );
    case 'DECK_INVALID':
      return msg(`The cloud refused this work (${deckIssueCodes(d)}) and nothing was synced; fix the pages as indicated and try again`, `云端拒绝了这份作品（${deckIssueCodes(d)}），未同步；请按提示修正页面后重试`);
    case 'STORAGE_FULL':
      return msg('Your popost.ai cloud storage is full and nothing was synced; free up space or upgrade your plan, then try again', 'popost.ai 云端存储空间已满，未同步；请清理素材或升级会员后重试');
    case 'CLI_VERSION_TOO_OLD':
      return msg(`This popost Skill version ${VERSION} is too old (the platform needs ≥ ${num(d.minVersion)}); update the popost Skill and try again`, `当前 popost Skill 版本 ${VERSION} 过旧（平台要求 ≥ ${num(d.minVersion)}），请更新 popost Skill 后重试`);
    case 'CONTENT_REJECTED':
      return msg('The content did not pass popost.ai moderation; change the prompt or the reference images and quote again', '内容未通过 popost.ai 审核，请调整提示词或参考图后重新报价');
    case 'VIDEO_GENERATION_DISABLED':
      return msg('Video generation on popost.ai is not available for this account yet; nothing was charged', 'popost.ai 视频生成暂未对当前账户开放，未扣费');
    case 'VIDEO_MODEL_UNAVAILABLE':
      return msg('popost.ai does not offer this video model now (popost video generate --models lists those it does); nothing was charged', 'popost.ai 目前不提供这个视频模型（popost video generate --models 列出可用模型），未扣费');
    case 'VIDEO_OPTION_UNSUPPORTED':
      return msg(
        'The video model does not take these settings (resolution, seconds, aspect ratio or references; popost video generate --models lists what each model takes); nothing was charged',
        '该视频模型不支持这些设置（分辨率、时长、画幅或参考素材；popost video generate --models 列出各模型支持的设置），未扣费',
      );
    case 'GENERATION_FAILED':
      return msg('popost.ai could not make it', 'popost.ai 未能生成');
    case 'QUOTE_EXPIRED':
      return msg('The price quote has expired; nothing was charged. Price it again', '报价已过期，未扣费；请重新报价');
    case 'QUOTE_MISMATCH':
      return msg('The request differs from its price quote; nothing was charged. Price it again', '请求与报价不一致，未扣费；请重新报价');
    case 'IDEMPOTENCY_KEY_REUSED':
      return msg('popost.ai already has a request with this idempotency key and other settings; nothing was charged', 'popost.ai 已有使用该幂等键但设置不同的请求，未扣费');
    case 'UPSTREAM_ERROR':
      return msg('The popost.ai generation service failed for now; try again later', 'popost.ai 生成服务暂时失败，请稍后重试');
    case 'SERVICE_UNAVAILABLE':
      return msg('popost.ai is temporarily unavailable; try again later', 'popost.ai 服务暂时不可用，请稍后重试');
    case 'TIMEOUT':
      return msg('popost.ai timed out while processing the request', 'popost.ai 处理超时');
    case 'NOT_IMPLEMENTED':
      return msg('popost.ai does not offer this feature yet', 'popost.ai 尚未开放该功能');
    case 'INTERNAL_ERROR':
      return msg('popost.ai internal error', 'popost.ai 内部错误');
    default:
      return msg('popost.ai returned an error', 'popost.ai 返回错误');
  }
};

/** Only known fields are read; the server's own text is appended as it is, truncated. */
export const describeError = (code: string | undefined, serverMessage?: unknown, details?: unknown, keyEnv = DEFAULT_KEY_ENV): string => {
  let text = message(code, isRecord(details) ? details : {}, keyEnv);
  if (serverMessage) {
    const said = String(serverMessage).trim().slice(0, 200);
    text += msg(` (popost.ai says: ${said})`, `（平台说明：${said}）`);
  }
  return `${text} [${code || 'UNKNOWN'}]`;
};
