/**
 * What `unpack` checks about an archive before any file is written (port of the checks in `project_bundle.import_project`):
 * duplicate names, total expanded size, path traversal, absolute or backslash paths and symlink entries. fflate lists
 * names and sizes; the symlink flag lives in the central directory's external attributes, which fflate does not expose,
 * so it is read here.
 */
import { unzipSync } from 'fflate';
import { ValueError } from './errors';

export const MAX_EXPANDED = 512 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  size: number;
}

/** Names and expanded sizes in archive order, without inflating anything. */
export const listEntries = (data: Uint8Array): ZipEntry[] => {
  const entries: ZipEntry[] = [];
  unzipSync(data, {
    filter: (file) => {
      entries.push({ name: file.name, size: file.originalSize });
      return false;
    },
  });
  return entries;
};

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** Names of entries whose Unix mode says "symbolic link". An archive without a readable directory yields none. */
export const symlinkNames = (data: Uint8Array): Set<string> => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const found = new Set<string>();
  let eocd = data.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== EOCD) eocd--;
  if (eocd < 0) return found;
  let offset = view.getUint32(eocd + 16, true);
  for (let i = view.getUint16(eocd + 10, true); i > 0 && offset + 46 <= data.length; i--) {
    if (view.getUint32(offset, true) !== CENTRAL) break;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const mode = view.getUint32(offset + 38, true) >>> 16;
    if ((mode & S_IFMT) === S_IFLNK) {
      const utf8 = (view.getUint16(offset + 8, true) & 0x800) !== 0;
      const raw = data.subarray(offset + 46, offset + 46 + nameLength);
      found.add(new TextDecoder(utf8 ? 'utf-8' : 'latin1').decode(raw));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return found;
};

const unsafeName = (name: string): boolean =>
  name.startsWith('/') || name.split('/').includes('..') || name.includes('\\');

/** Throws a `ValueError` when the archive must not be unpacked. `manifestName` has to be one of its entries. */
export const assertSafeArchive = (data: Uint8Array, manifestName: string): ZipEntry[] => {
  const entries = listEntries(data);
  const names = entries.map((entry) => entry.name);
  if (names.length !== new Set(names).size || !names.includes(manifestName)) throw new ValueError('invalid project archive');
  if (entries.reduce((sum, entry) => sum + entry.size, 0) > MAX_EXPANDED) throw new ValueError('project archive too large');
  const links = symlinkNames(data);
  if (entries.some((entry) => unsafeName(entry.name) || links.has(entry.name))) throw new ValueError('unsafe archive path');
  return entries;
};
