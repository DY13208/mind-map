import { Space } from '@docmost/db/types/entity.types';

export class SearchResponseDto {
  id: string;
  title: string;
  icon: string;
  parentPageId: string;
  creatorId: string;
  rank: number;
  highlight: string;
  matchedText: string[];
  matchSource?: 'page' | 'attachment';
  matchedAttachmentName?: string | null;
  wholeWord: boolean;
  createdAt: Date;
  updatedAt: Date;
  space: Partial<Space>;
}
