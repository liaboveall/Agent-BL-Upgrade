// Reading a picked or dropped file into the shape /api/agent/ingest takes: the actual bytes, base64.
import { t } from './i18n.js';

export const MAX_FILE_BYTES = 8_388_608;
export const MAX_FILES = 12;

export function fileDocument(file, Reader = FileReader) {
  if (file.size > MAX_FILE_BYTES) return Promise.reject(new Error(t('ebld_too_large')));
  const extension = file.name.split('.').at(-1).toLowerCase();
  const mime = file.type || ({ md: 'text/markdown', txt: 'text/plain', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[extension]);
  return new Promise((resolve, reject) => {
    const reader = new Reader();
    reader.onerror = () => reject(new Error(t('ebld_read_failed')));
    reader.onload = () => resolve({ name: file.name, mime_type: mime, content_base64: String(reader.result).split(',').slice(1).join(',') });
    reader.readAsDataURL(file);
  });
}
