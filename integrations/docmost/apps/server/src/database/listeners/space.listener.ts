import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../common/events/event.contants';

export class SpaceEvent {
  spaceId: string;
  workspaceId: string;
}

/**
 * 2026-09-22: search/ai queue producers removed (dead queues, no consumer).
 * See PageListener comment for details.
 */
@Injectable()
export class SpaceListener {
  private readonly logger = new Logger(SpaceListener.name);

  @OnEvent(EventName.SPACE_DELETED)
  async handleSpaceDeleted(_event: SpaceEvent) {}
}
