import https from 'node:https';
import { UserError } from '../lib/library.ts';
import type { TelegramApi } from './telegram.ts';

// Bot API Document and File objects, not validated in advance: fields the reader checks are unknown.
export type TelegramDocument = { file_name?: string; file_size?: number; file_id?: unknown };
type TelegramFile = { file_size?: number; file_path?: unknown };
// The part of https.get the reader uses, so tests can pass a fake.
type FileResponse = {
  statusCode?: number; headers: { 'content-length'?: string }; complete: boolean; destroy(): void;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'error' | 'aborted' | 'end', listener: () => void): unknown;
};
export type HttpsGet = (options: { hostname: string; family: number; path: string; timeout: number },
  onResponse: (response: FileResponse) => void) => { destroy(): void; on(event: 'timeout' | 'error' | 'close', listener: () => void): unknown };

export const SEED_BYTES = 256 * 1024;
const tooLarge = () => new UserError('Файл слишком большой. Предел файла и всего черновика — 256 КиБ текста.');
const failed = () => new UserError('Не удалось прочитать файл целиком. Черновик не изменён; отправь файл ещё раз.');

// Fixed Telegram origin; never follow a redirect carrying the bot credential.
// Files stay in memory, and only decoded text is persisted in the user's draft.
export function createSeedFileReader(token: string, api: TelegramApi, { get = https.get }: { get?: HttpsGet } = {}) {
  return async (document: TelegramDocument) => {
    if (!/\.(txt|md)$/i.test(document?.file_name || '')) {
      throw new UserError('Пришли текстовый файл .txt или .md в кодировке UTF-8. PDF и DOCX пока не поддерживаются.');
    }
    if ((document.file_size ?? 0) > SEED_BYTES) throw tooLarge();
    if (typeof document.file_id !== 'string' || !document.file_id) throw failed();
    try {
      const file = await api('getFile', { file_id: document.file_id }) as TelegramFile;
      if ((file.file_size ?? 0) > SEED_BYTES) throw tooLarge();
      if (typeof file.file_path !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(file.file_path)
          || file.file_path.split('/').some(p => !p || p === '.' || p === '..')) throw failed();
      const data = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let timer: NodeJS.Timeout | undefined;
        const request = get({ hostname: 'api.telegram.org', family: 4,
          path: `/file/bot${token}/${file.file_path}`, timeout: 15000 }, response => {
          if (response.statusCode !== 200) { response.destroy(); reject(failed()); return; }
          if (Number(response.headers['content-length']) > SEED_BYTES) {
            response.destroy(); reject(tooLarge()); return;
          }
          response.on('data', chunk => {
            size += chunk.length;
            if (size > SEED_BYTES) { response.destroy(); reject(tooLarge()); }
            else chunks.push(chunk);
          });
          response.on('error', () => reject(failed()));
          response.on('aborted', () => reject(failed()));
          response.on('end', () => {
            if (!response.complete || (Number.isSafeInteger(file.file_size) && size !== file.file_size)) reject(failed());
            else resolve(Buffer.concat(chunks));
          });
        });
        timer = setTimeout(() => { request.destroy(); reject(failed()); }, 20000);
        request.on('timeout', () => { request.destroy(); reject(failed()); });
        request.on('error', () => reject(failed()));
        request.on('close', () => clearTimeout(timer));
      });
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/\r\n?/g, '\n').trim(); }
      catch { throw new UserError('Не удалось прочитать UTF-8. Сохрани файл как UTF-8 и отправь снова; черновик не изменён.'); }
      if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
        throw new UserError('Нужен непустой текстовый файл .txt или .md без двоичных данных. Черновик не изменён.');
      }
      return text;
    } catch (error) {
      if (error instanceof UserError) throw error;
      throw failed();
    }
  };
}
