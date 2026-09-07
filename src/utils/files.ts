import type { FileCategory } from '../models/transfer';

/**
 * Mapping between MIME types, extensions and the picker's categories (§16).
 */

const EXTENSION_CATEGORIES: Record<string, FileCategory> = {
  jpg: 'photos', jpeg: 'photos', png: 'photos', gif: 'photos', webp: 'photos',
  heic: 'photos', heif: 'photos', bmp: 'photos', tiff: 'photos', svg: 'photos',

  mp4: 'videos', mov: 'videos', mkv: 'videos', avi: 'videos', webm: 'videos',
  m4v: 'videos', '3gp': 'videos', flv: 'videos', wmv: 'videos',

  mp3: 'music', wav: 'music', flac: 'music', aac: 'music', ogg: 'music',
  m4a: 'music', wma: 'music', opus: 'music',

  pdf: 'documents', doc: 'documents', docx: 'documents', xls: 'documents',
  xlsx: 'documents', ppt: 'documents', pptx: 'documents', txt: 'documents',
  rtf: 'documents', odt: 'documents', csv: 'documents', md: 'documents',
  epub: 'documents', pages: 'documents', numbers: 'documents', key: 'documents',

  apk: 'apk', aab: 'apk', ipa: 'apk',

  zip: 'archives', rar: 'archives', '7z': 'archives', tar: 'archives',
  gz: 'archives', bz2: 'archives', xz: 'archives',
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Which picker category a file belongs to.
 *
 * The MIME type is tried first because it is what the OS actually reports;
 * the extension is the fallback for the many providers that return
 * `application/octet-stream`.
 */
export function categoryOf(name: string, mimeType: string): FileCategory {
  if (mimeType.startsWith('image/')) return 'photos';
  if (mimeType.startsWith('video/')) return 'videos';
  if (mimeType.startsWith('audio/')) return 'music';

  const byExtension = EXTENSION_CATEGORIES[extensionOf(name)];
  if (byExtension) return byExtension;

  if (mimeType.startsWith('text/') || mimeType.includes('document')) {
    return 'documents';
  }
  if (mimeType.includes('zip') || mimeType.includes('compressed')) {
    return 'archives';
  }
  return 'other';
}

export const CATEGORY_LABELS: Record<FileCategory, string> = {
  photos: 'Photos',
  videos: 'Videos',
  music: 'Music',
  documents: 'Documents',
  apk: 'Apps',
  archives: 'Archives',
  other: 'Other Files',
  folders: 'Folders',
};

/** Best-effort MIME type for a filename, used when the OS gives us nothing. */
export function guessMimeType(name: string): string {
  const ext = extensionOf(name);
  const category = EXTENSION_CATEGORIES[ext];
  switch (category) {
    case 'photos':
      return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
    case 'videos':
      return `video/${ext === 'mov' ? 'quicktime' : ext}`;
    case 'music':
      return `audio/${ext === 'mp3' ? 'mpeg' : ext}`;
    case 'apk':
      return 'application/vnd.android.package-archive';
    case 'archives':
      return ext === 'zip' ? 'application/zip' : `application/x-${ext}`;
    case 'documents':
      if (ext === 'pdf') return 'application/pdf';
      if (ext === 'txt' || ext === 'md' || ext === 'csv') return `text/${ext}`;
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}

/** True for types worth trying to render a thumbnail for. */
export function isPreviewable(mimeType: string): boolean {
  return mimeType.startsWith('image/') || mimeType.startsWith('video/');
}
