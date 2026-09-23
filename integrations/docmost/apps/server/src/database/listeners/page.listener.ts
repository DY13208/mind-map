import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../common/events/event.contants';
import { EnvironmentService } from '../../integrations/environment/environment.service';

export class PageEvent {
  pageIds: string[];
  workspaceId: string;
}

/**
 * 2026-09-22: search/ai queue producers removed.
 * Both queues had no consumer in this fork (search uses PostgreSQL
 * full-text search directly; the AI/embeddings module does not exist),
 * so every job enqueued here accumulated forever (1.5M+ dead jobs).
 */
@Injectable()
export class PageListener {
  private readonly logger = new Logger(PageListener.name);

  constructor(private readonly environmentService: EnvironmentService) {}

  @OnEvent(EventName.PAGE_CREATED)
  async handlePageCreated(_event: PageEvent) {}

  @OnEvent(EventName.PAGE_UPDATED)
  async handlePageUpdated(event: PageEvent) {
    const { pageIds } = event;

    // Fire-and-forget: never block Wiki save / search indexing on Mindmap sync.
    void this.notifyMindMapWikiSaved(pageIds).catch((err) => {
      this.logger.warn(
        `Wiki→Mindmap notify failed: ${err?.message || err}`,
      );
    });
  }

  @OnEvent(EventName.PAGE_DELETED)
  async handlePageDeleted(_event: PageEvent) {}

  @OnEvent(EventName.PAGE_SOFT_DELETED)
  async handlePageSoftDeleted(_event: PageEvent) {}

  @OnEvent(EventName.PAGE_RESTORED)
  async handlePageRestored(_event: PageEvent) {}

  /** Coalesce PAGE_UPDATED storms (collab autosave / Mindmap→Wiki) per page. */
  private readonly pendingNotifyIds = new Set<string>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly NOTIFY_DEBOUNCE_MS = 2000;

  /**
   * Notify mind-map that Wiki pages were saved. Async enqueue only —
   * must not await Mindmap sync completion.
   *
   * Debounced: collab + Mindmap→Wiki standard writes can emit dozens of
   * PAGE_UPDATED/sec; without coalesce this saturates Docmost CPU and
   * makes Wiki open/navigate feel stuck.
   */
  private async notifyMindMapWikiSaved(pageIds: string[]): Promise<void> {
    if (!this.environmentService.isWikiMindmapAutoSyncEnabled()) return;
    const ids = (pageIds || []).map(String).filter(Boolean);
    if (!ids.length) return;
    for (const id of ids) this.pendingNotifyIds.add(id);
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const batch = Array.from(this.pendingNotifyIds);
      this.pendingNotifyIds.clear();
      void this.flushMindMapWikiSaved(batch).catch((err) => {
        this.logger.warn(
          `Wiki→Mindmap notify flush failed: ${err?.message || err}`,
        );
      });
    }, PageListener.NOTIFY_DEBOUNCE_MS);
  }

  private async flushMindMapWikiSaved(pageIds: string[]): Promise<void> {
    const base = this.environmentService.getMindMapInternalUrl();
    const secret = this.environmentService.getWikiMindmapHookSecret();
    if (!base || !secret) {
      this.logger.debug(
        'Wiki→Mindmap hook skipped (MIND_MAP_INTERNAL_URL / WIKI_MINDMAP_HOOK_SECRET unset)',
      );
      return;
    }
    if (!pageIds.length) return;

    const url = `${base}/api/knowledge/wiki-page-saved`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Wiki-Mindmap-Hook-Secret': secret,
        },
        body: JSON.stringify({ page_ids: pageIds }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.logger.warn(
          `Wiki→Mindmap hook HTTP ${res.status}: ${text.slice(0, 200)}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
