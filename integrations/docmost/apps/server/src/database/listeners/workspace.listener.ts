import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../common/events/event.contants';

export class WorkspaceEvent {
  workspaceId: string;
}

/**
 * 2026-09-22: search/ai queue producers removed (dead queues, no consumer).
 * See PageListener comment for details.
 */
@Injectable()
export class WorkspaceListener {
  private readonly logger = new Logger(WorkspaceListener.name);

  @OnEvent(EventName.WORKSPACE_DELETED)
  async handleWorkspaceDeleted(_event: WorkspaceEvent) {}
}
