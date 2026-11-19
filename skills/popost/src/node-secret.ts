/** Read a key only from a real terminal, with echo disabled for the complete input lifetime. */
import type { ReadStream } from 'node:tty';

export const readTerminalSecret = (input: ReadStream, write: (text: string) => void): Promise<string> => new Promise((resolve, reject) => {
  if (!input.isTTY || !input.setRawMode) {
    reject(new Error('A private interactive terminal is required. Run auth set --prompt in your own terminal; do not paste a key into chat.'));
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
  const ended = () => finish(new Error('Key input ended before confirmation; nothing was saved.'));
  const failed = () => finish(new Error('Key input failed; nothing was saved.'));
  const receive = (data: Buffer) => {
    for (const char of data.toString('utf8')) {
      if (char === '\u0003' || char === '\u0004') { finish(new Error('Key setup cancelled; nothing was saved.')); return; }
      if (char === '\r' || char === '\n') { finish(); return; }
      if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
      else value += char;
      if (value.length > 512) { finish(new Error('Key input is too long; nothing was saved.')); return; }
    }
  };
  input.setRawMode(true);
  write('Paste the API key (hidden), then press Enter. Ctrl-C cancels: ');
  input.on('data', receive);
  input.once('end', ended);
  input.once('error', failed);
  input.resume();
});
