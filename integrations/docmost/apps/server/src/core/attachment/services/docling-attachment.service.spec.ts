import { DoclingAttachmentService } from './docling-attachment.service';

describe('DoclingAttachmentService', () => {
  const originalFetch = global.fetch;
  const envNames = [
    'DOCLING_URL',
    'DOCLING_API_KEY',
    'KB_DOCLING_OCR_MODE',
    'KB_DOCLING_OCR_FORCE',
    'KB_DOCLING_OCR_MIN_CHARS_PER_PAGE',
    'KB_DOCLING_OCR_TEXTLESS_PAGE_PCT',
    'KB_DOCLING_OCR_MIXED_MIN_PAGES',
  ];
  const savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));

  afterEach(() => {
    global.fetch = originalFetch;
    for (const name of envNames) {
      const value = savedEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    jest.restoreAllMocks();
  });

  function createService({
    fileName,
    fileExt,
    bytes = 'fixture',
    extracted,
    updated = true,
  }: {
    fileName: string;
    fileExt: string;
    bytes?: string;
    extracted?: string;
    updated?: boolean;
  }) {
    const updatedAtExact = '2026-11-02 00:00:00.123456+00';
    const attachmentRepo = {
      findByIdWithContent: jest.fn().mockResolvedValue({
        id: 'attachment-id',
        fileName,
        fileExt,
        filePath: `files/${fileName}`,
        updatedAt: new Date(updatedAtExact),
        updatedAtExact,
        deletedAt: null,
      }),
      updateAttachmentText: jest.fn().mockResolvedValue(updated),
    };
    const storageService = { read: jest.fn().mockResolvedValue(Buffer.from(bytes)) };
    const service = new DoclingAttachmentService(storageService as any, attachmentRepo as any);
    return { service, attachmentRepo, storageService, updatedAtExact, extracted };
  }

  function doclingResponse(text: string) {
    return {
      body: { children: [{ $ref: '#/texts/0' }] },
      texts: [{ text }],
      pages: { '1': {} },
    };
  }

  function successfulDoclingFetch(document: unknown, onSubmit?: (form: FormData, init?: RequestInit) => void) {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/convert/file/async')) {
        onSubmit?.(init?.body as FormData, init);
        return new Response(JSON.stringify({ task_id: 'task-1' }), { status: 200 });
      }
      if (url.includes('/v1/status/poll/')) {
        return new Response(JSON.stringify({ task_status: 'success' }), { status: 200 });
      }
      if (url.includes('/v1/result/')) {
        return new Response(JSON.stringify({ document: { json_content: document } }), { status: 200 });
      }
      throw new Error(`Unexpected Docling request: ${url}`);
    }) as typeof fetch;
  }

  it('runs OCR fallback for a textless PDF and indexes extracted text', async () => {
    process.env.DOCLING_URL = 'http://docling.test';
    process.env.KB_DOCLING_OCR_MODE = 'auto';
    const requests: Array<{ ocr: string; force?: string }> = [];
    const firstDocument = { body: { children: [] }, texts: [], pages: { '1': {} } };
    let requestNumber = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/convert/file/async')) {
        requestNumber++;
        const form = init?.body as FormData;
        requests.push({ ocr: String(form.get('do_ocr')), force: form.get('force_ocr')?.toString() });
        return new Response(JSON.stringify({ task_id: `task-${requestNumber}` }), { status: 200 });
      }
      if (url.includes('/v1/status/poll/')) {
        return new Response(JSON.stringify({ task_status: 'success' }), { status: 200 });
      }
      if (url.includes('/v1/result/')) {
        const document = url.endsWith('task-1') ? firstDocument : doclingResponse('识别出来的图片文字');
        return new Response(JSON.stringify({ document: { json_content: document } }), { status: 200 });
      }
      throw new Error(`Unexpected Docling request: ${url}`);
    }) as typeof fetch;

    const { service, attachmentRepo, storageService, updatedAtExact } = createService({
      fileName: '扫描件.pdf', fileExt: '.pdf',
    });
    await service.extractAttachment('attachment-id');

    expect(requests).toEqual([{ ocr: 'false', force: undefined }, { ocr: 'true', force: 'true' }]);
    expect(attachmentRepo.updateAttachmentText).toHaveBeenCalledWith(
      'attachment-id', 'files/扫描件.pdf', updatedAtExact, '识别出来的图片文字',
    );
    expect(storageService.read).toHaveBeenCalledWith('files/扫描件.pdf');
  });

  it('indexes TXT as UTF-8 without calling Docling', async () => {
    process.env.DOCLING_URL = 'http://docling.test';
    global.fetch = jest.fn() as typeof fetch;
    const { service, attachmentRepo } = createService({
      fileName: '说明.txt', fileExt: '.txt', bytes: '\uFEFF这是UTF-8正文',
    });

    await service.extractAttachment('attachment-id');

    expect(global.fetch).not.toHaveBeenCalled();
    expect(attachmentRepo.updateAttachmentText).toHaveBeenCalledWith(
      'attachment-id', 'files/说明.txt', '2026-11-02 00:00:00.123456+00', '这是UTF-8正文',
    );
  });

  it('OCRs an image in one pass with TIFF MIME type and the configured API key', async () => {
    process.env.DOCLING_URL = 'http://docling.test';
    process.env.DOCLING_API_KEY = 'test-api-key';
    process.env.KB_DOCLING_OCR_MODE = 'auto';
    const submissions: Array<{ form: FormData; init?: RequestInit }> = [];
    successfulDoclingFetch(doclingResponse('图像文字'), (form, init) => submissions.push({ form, init }));
    const { service, attachmentRepo } = createService({ fileName: '扫描.tif', fileExt: '.tif' });

    await service.extractAttachment('attachment-id');

    expect(submissions).toHaveLength(1);
    expect(submissions[0].form.get('do_ocr')).toBe('true');
    expect(submissions[0].form.get('force_ocr')).toBe('true');
    expect((submissions[0].form.get('files') as Blob).type).toBe('image/tiff');
    expect((submissions[0].init?.headers as Record<string, string>)['X-Api-Key']).toBe('test-api-key');
    expect(attachmentRepo.updateAttachmentText).toHaveBeenCalledWith(
      'attachment-id', 'files/扫描.tif', '2026-11-02 00:00:00.123456+00', '图像文字',
    );
  });

  it('uses non-forced OCR for mixed PDFs and honors the configured scan thresholds', async () => {
    process.env.DOCLING_URL = 'http://docling.test';
    process.env.KB_DOCLING_OCR_MODE = 'auto';
    process.env.KB_DOCLING_OCR_FORCE = 'true';
    process.env.KB_DOCLING_OCR_MIN_CHARS_PER_PAGE = '10';
    process.env.KB_DOCLING_OCR_TEXTLESS_PAGE_PCT = '60';
    process.env.KB_DOCLING_OCR_MIXED_MIN_PAGES = '1';
    const firstDocument = {
      body: { children: [{ $ref: '#/texts/0' }] },
      texts: [{ text: 'This page has enough native text to exceed the configured average threshold.', prov: [{ page_no: 1 }] }],
      pages: { '1': {}, '2': {} },
    };
    let requestNumber = 0;
    const submissions: FormData[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/convert/file/async')) {
        requestNumber++;
        submissions.push(init?.body as FormData);
        return new Response(JSON.stringify({ task_id: `task-${requestNumber}` }), { status: 200 });
      }
      if (url.includes('/v1/status/poll/')) {
        return new Response(JSON.stringify({ task_status: 'success' }), { status: 200 });
      }
      if (url.includes('/v1/result/')) {
        const document = url.endsWith('task-1') ? firstDocument : doclingResponse('This page has enough native text to exceed the configured average threshold. OCR added this scanned page text.');
        return new Response(JSON.stringify({ document: { json_content: document } }), { status: 200 });
      }
      throw new Error(`Unexpected Docling request: ${url}`);
    }) as typeof fetch;
    const { service, attachmentRepo } = createService({ fileName: 'mixed.pdf', fileExt: '.pdf' });

    await service.extractAttachment('attachment-id');

    expect(submissions).toHaveLength(2);
    expect(submissions[0].get('do_ocr')).toBe('false');
    expect(submissions[1].get('do_ocr')).toBe('true');
    expect(submissions[1].get('force_ocr')).toBeNull();
    expect(attachmentRepo.updateAttachmentText).toHaveBeenCalledWith(
      'attachment-id', 'files/mixed.pdf', '2026-11-02 00:00:00.123456+00',
      'This page has enough native text to exceed the configured average threshold. OCR added this scanned page text.',
    );
  });

  it('does not overwrite text when the attachment changed during extraction', async () => {
    process.env.DOCLING_URL = 'http://docling.test';
    process.env.KB_DOCLING_OCR_MODE = 'always';
    const submissions: FormData[] = [];
    successfulDoclingFetch(doclingResponse('提取文字'), form => submissions.push(form));
    const { service, attachmentRepo, updatedAtExact } = createService({
      fileName: 'report.pdf', fileExt: '.pdf', updated: false,
    });

    await service.extractAttachment('attachment-id');

    expect(submissions).toHaveLength(1);
    expect(submissions[0].get('do_ocr')).toBe('true');
    expect(submissions[0].get('force_ocr')).toBeNull();
    expect(attachmentRepo.updateAttachmentText).toHaveBeenCalledWith(
      'attachment-id', 'files/report.pdf', updatedAtExact, '提取文字',
    );
  });
});
