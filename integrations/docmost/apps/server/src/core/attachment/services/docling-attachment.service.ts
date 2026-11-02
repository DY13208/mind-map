import { Injectable, Logger } from '@nestjs/common';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { StorageService } from '../../../integrations/storage/storage.service';

type DoclingDocument = Record<string, any>;
type OcrKind = 'full' | 'mixed' | null;

const MAX_INDEXED_CHARS = 1_000_000;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp']);

function resolveRef(doc: DoclingDocument, ref: string) {
  const match = /^#\/(\w+)\/(\d+)$/.exec(ref || '');
  const collection = match && doc[match[1]];
  return Array.isArray(collection) ? collection[Number(match[2])] : null;
}

function doclingText(doc: DoclingDocument): string {
  const output: string[] = [];
  const seen = new Set<string>();
  const visit = (ref: string) => {
    if (!ref || seen.has(ref)) return;
    seen.add(ref);
    const item = resolveRef(doc, ref);
    if (!item) return;
    const collection = ref.split('/')[1];
    if (collection === 'body' || collection === 'groups') {
      for (const child of item.children || []) visit(child.$ref || child.cref);
      return;
    }
    if (collection === 'tables') {
      const cells = item.data?.table_cells || [];
      const rows = new Map<number, Map<number, string>>();
      for (const cell of cells) {
        const row = Number(cell.start_row_offset_idx || 0);
        const col = Number(cell.start_col_offset_idx || 0);
        if (!rows.has(row)) rows.set(row, new Map());
        rows.get(row).set(col, String(cell.text || '').trim());
      }
      for (const row of [...rows.keys()].sort((a, b) => a - b)) {
        output.push([...rows.get(row).entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join(' | '));
      }
    } else if (collection === 'pictures') {
      for (const caption of item.captions || []) {
        const resolved = resolveRef(doc, caption.$ref || caption.cref);
        if (resolved?.text) output.push(String(resolved.text));
      }
    } else if (item.text) {
      output.push(String(item.text));
    }
    for (const child of item.children || []) visit(child.$ref || child.cref);
  };

  for (const child of doc.body?.children || []) visit(child.$ref || child.cref);
  if (!output.length) {
    // Some Docling versions omit body refs but retain ordered text elements.
    for (const item of doc.texts || []) if (item?.text) output.push(String(item.text));
  }
  return output.join('\n').replace(/\u0000/g, '').trim().slice(0, MAX_INDEXED_CHARS);
}

function provenancePages(item: any): number[] {
  return Array.isArray(item?.prov)
    ? item.prov.map((entry: any) => entry?.page_no).filter(Number.isInteger)
    : [];
}

function nonSpaceLength(value: unknown): number {
  return String(value ?? '').replace(/\s+/g, '').length;
}

function scanStats(doc: DoclingDocument) {
  const pages = new Set<number>(Object.keys(doc.pages || {}).map(Number).filter(Number.isInteger));
  const textPages = new Set<number>();
  const picturePages = new Set<number>();
  let chars = 0;
  const countText = (item: any, count: number) => {
    chars += count;
    for (const page of provenancePages(item)) {
      pages.add(page);
      if (count > 0) textPages.add(page);
    }
  };

  for (const item of Array.isArray(doc.texts) ? doc.texts : []) {
    countText(item, nonSpaceLength(item?.text));
  }
  for (const table of Array.isArray(doc.tables) ? doc.tables : []) {
    const cells = Array.isArray(table?.data?.table_cells) ? table.data.table_cells : [];
    countText(table, cells.reduce((sum: number, cell: any) => sum + nonSpaceLength(cell?.text), 0));
  }
  for (const picture of Array.isArray(doc.pictures) ? doc.pictures : []) {
    for (const page of provenancePages(picture)) {
      pages.add(page);
      picturePages.add(page);
    }
  }

  let textlessPicturePages = 0;
  for (const page of picturePages) if (!textPages.has(page)) textlessPicturePages++;
  const textlessPages = [...pages].filter(page => !textPages.has(page)).length;
  return { pages: pages.size, chars, textlessPicturePages, textlessPages };
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function scanKind(
  stats: ReturnType<typeof scanStats>,
  minCharsPerPage: number,
  textlessPagePct: number,
  mixedMinPages: number,
): OcrKind {
  if (!stats.pages) return stats.chars === 0 ? 'full' : null;
  if (
    stats.chars / stats.pages < minCharsPerPage ||
    (stats.textlessPicturePages / stats.pages) * 100 >= textlessPagePct
  ) {
    return 'full';
  }
  if (mixedMinPages > 0 && stats.textlessPages >= mixedMinPages) return 'mixed';
  return null;
}

function textFromPlainText(buffer: Buffer): string {
  let decoded: string;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    decoded = buffer.toString('utf16le', 2);
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    decoded = new TextDecoder('utf-16be').decode(buffer.subarray(2));
  } else {
    decoded = buffer.toString('utf8').replace(/^\uFEFF/, '');
  }
  return decoded
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, MAX_INDEXED_CHARS);
}

@Injectable()
export class DoclingAttachmentService {
  private readonly logger = new Logger(DoclingAttachmentService.name);

  constructor(
    private readonly storageService: StorageService,
    private readonly attachmentRepo: AttachmentRepo,
  ) {}

  async extractAttachment(attachmentId: string): Promise<void> {
    const attachment = await this.attachmentRepo.findByIdWithContent(attachmentId);
    if (!attachment || attachment.deletedAt || !attachment.filePath) return;

    const ext = String(attachment.fileExt || '').replace(/^\./, '').toLowerCase();
    if (ext !== 'pdf' && ext !== 'docx' && ext !== 'txt' && !IMAGE_EXTENSIONS.has(ext)) return;

    const buffer = await this.storageService.read(attachment.filePath);
    const mode = String(process.env.KB_DOCLING_OCR_MODE || '').trim().toLowerCase() || 'auto';
    if (!['auto', 'off', 'always'].includes(mode)) {
      throw new Error('KB_DOCLING_OCR_MODE must be auto, off or always');
    }

    // Plain text needs no OCR service and Docling's file endpoint does not accept TXT.
    let text = ext === 'txt' ? textFromPlainText(buffer) : '';
    if (ext !== 'txt') {
      if (mode === 'off' && IMAGE_EXTENSIONS.has(ext)) return;
      const forceConfigured = envFlag('KB_DOCLING_OCR_FORCE', true);
      const isImage = IMAGE_EXTENSIONS.has(ext);
      if (mode === 'always' || (mode === 'auto' && isImage)) {
        // The first and only pass already enables OCR; do not pay for a redundant plain pass.
        const document = await this.convert(
          buffer,
          attachment.fileName,
          ext,
          true,
          mode === 'auto' && forceConfigured,
        );
        text = doclingText(document);
      } else {
        const first = await this.convert(buffer, attachment.fileName, ext, false, false);
        text = doclingText(first);
        if (mode === 'auto' && ext === 'pdf') {
          const kind = scanKind(
            scanStats(first),
            envInt('KB_DOCLING_OCR_MIN_CHARS_PER_PAGE', 20, 0, 100_000),
            envInt('KB_DOCLING_OCR_TEXTLESS_PAGE_PCT', 60, 1, 100),
            envInt('KB_DOCLING_OCR_MIXED_MIN_PAGES', 1, 0, 100_000),
          );
          if (kind) {
            try {
              // force_ocr is reserved for mostly scanned PDFs; mixed PDFs retain native text.
              const ocrResult = await this.convert(
                buffer,
                attachment.fileName,
                ext,
                true,
                kind === 'full' && forceConfigured,
              );
              const ocrText = doclingText(ocrResult);
              if (ocrText.length > text.length) text = ocrText;
            } catch (error) {
              if (!text) throw error;
              this.logger.warn(`OCR fallback failed for ${attachmentId} (${(error as Error)?.name || 'unknown error'})`);
            }
          }
        }
      }
    }

    if (!text) throw new Error(`No text extracted for attachment ${attachmentId}`);
    const updated = await this.attachmentRepo.updateAttachmentText(
      attachmentId,
      attachment.filePath,
      attachment.updatedAtExact,
      text,
    );
    if (!updated) {
      this.logger.debug(`Skipped stale Docling result for attachment ${attachmentId}`);
      return;
    }
    this.logger.log(`Indexed extracted text for attachment ${attachmentId} (${text.length} chars)`);
  }

  private async convert(
    buffer: Buffer,
    fileName: string,
    ext: string,
    ocr: boolean,
    forceOcr: boolean,
  ): Promise<DoclingDocument> {
    const baseUrl = String(process.env.DOCLING_URL || '').trim().replace(/\/+$/, '');
    if (!baseUrl) throw new Error('DOCLING_URL is not configured');

    const form = new FormData();
    const mimeType = this.mimeType(ext);
    const blobBytes = new Uint8Array(
      buffer.buffer as ArrayBuffer,
      buffer.byteOffset,
      buffer.byteLength,
    );
    form.append('files', new Blob([blobBytes], { type: mimeType }), fileName);
    form.append('to_formats', 'json');
    form.append('from_formats', ext === 'pdf' ? 'pdf' : ext === 'docx' ? 'docx' : 'image');
    form.append('do_ocr', String(ocr));
    form.append('image_export_mode', 'placeholder');
    form.append('include_images', 'false');
    form.append('abort_on_error', 'false');
    form.append('document_timeout', String(envInt('KB_DOCLING_OCR_DOCUMENT_TIMEOUT_S', 1800, 60, 86_400)));
    if (ocr) {
      form.append('ocr_preset', String(process.env.KB_DOCLING_OCR_ENGINE || 'rapidocr'));
      const languages = String(process.env.KB_DOCLING_OCR_LANG || '')
        .split(/[\s,]+/)
        .map(value => value.trim())
        .filter(Boolean);
      for (const language of languages) form.append('ocr_lang', language);
      if (forceOcr) form.append('force_ocr', 'true');
    }

    const apiKey = String(process.env.DOCLING_API_KEY || '').trim();
    const headers = apiKey ? { 'X-Api-Key': apiKey } : undefined;
    const response = await fetch(`${baseUrl}/v1/convert/file/async`, {
      method: 'POST',
      body: form,
      headers,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Docling upload failed (${response.status})`);
    const submitted = await response.json();
    if (!submitted.task_id) throw new Error('Docling did not return a task id');

    const deadline = Date.now() + envInt('KB_DOCLING_OCR_TOTAL_TIMEOUT_MS', 3_600_000, 10_000, 21_600_000);
    let state = '';
    while (Date.now() < deadline) {
      const statusResponse = await fetch(
        `${baseUrl}/v1/status/poll/${encodeURIComponent(submitted.task_id)}?wait=5`,
        { headers, signal: AbortSignal.timeout(40_000) },
      );
      if (!statusResponse.ok) throw new Error(`Docling poll failed (${statusResponse.status})`);
      state = String((await statusResponse.json()).task_status || '');
      if (state === 'success') break;
      if (state === 'failure' || state === 'lost') throw new Error(`Docling task ${state}`);
      // Some servers return immediately despite the wait query parameter.
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (state !== 'success') throw new Error('Docling extraction timed out');

    const resultResponse = await fetch(`${baseUrl}/v1/result/${encodeURIComponent(submitted.task_id)}`, {
      headers,
      signal: AbortSignal.timeout(120_000),
    });
    if (!resultResponse.ok) throw new Error(`Docling result failed (${resultResponse.status})`);
    const result = await resultResponse.json();
    if (!result.document?.json_content) throw new Error('Docling returned no document content');
    return result.document.json_content;
  }

  private mimeType(ext: string): string {
    if (ext === 'pdf') return 'application/pdf';
    if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'tif' || ext === 'tiff') return 'image/tiff';
    return `image/${ext}`;
  }
}
