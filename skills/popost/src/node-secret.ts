/** Read a key only from a real terminal, with echo disabled for the complete input lifetime. */
import type { ReadStream } from 'node:tty';
import { msg } from './i18n';

export const readTerminalSecret = (input: ReadStream, write: (text: string) => void): Promise<string> => new Promise((resolve, reject) => {
  if (!input.isTTY || !input.setRawMode) {
    reject(
      new Error(
        msg(
          'A private interactive terminal is required. Run auth set --prompt in your own terminal; do not paste a key into chat.',
          '需要一个私密的交互式终端。请在你自己的终端里运行 auth set --prompt；不要把 Key 粘贴到对话里。',
        ),
      ),
    );
    return;
  }
  const wasRaw = input.isRaw;
  const wasPaused = input.readableFlowing !== true;
  let value = '';
  const finish = (error?: Error) => {
    input.removeListener('data', receive);
    input.removeListener('end', ended);
    input.removeListener('error', failed);
    input.setRawMode(wasRaw);
    if (wasPaused) input.pause();
    write('\n');
    if (error) reject(error); else resolve(value);
  };
  const ended = () => finish(new Error(msg('Key input ended before confirmation; nothing was saved.', 'Key 输入在确认前结束；未保存任何内容。')));
  const failed = () => finish(new Error(msg('Key input failed; nothing was saved.', 'Key 输入失败；未保存任何内容。')));
  const receive = (data: Buffer) => {
    for (const char of data.toString('utf8')) {
      if (char === '\u0003' || char === '\u0004') { finish(new Error(msg('Key setup cancelled; nothing was saved.', 'Key 设置已取消；未保存任何内容。'))); return; }
      if (char === '\r' || char === '\n') { finish(); return; }
      if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
      else value += char;
      if (value.length > 512) { finish(new Error(msg('Key input is too long; nothing was saved.', 'Key 输入过长；未保存任何内容。'))); return; }
    }
  };
  input.setRawMode(true);
  write(msg('Paste the API key (hidden), then press Enter. Ctrl-C cancels: ', '粘贴 API Key（不回显），然后按回车。按 Ctrl-C 取消：'));
  input.on('data', receive);
  input.once('end', ended);
  input.once('error', failed);
  input.resume();
});
