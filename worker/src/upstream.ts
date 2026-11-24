import type { BookSource, Catalogue } from './service';

// Placeholders: the real Gutenberg fetch and catalogue search wait on reading
// Project Gutenberg's rules for robot (automated) access.

export const upstreamSource: BookSource = {
  async fetchText(): Promise<string | null> {
    throw new Error('upstream not configured: book fetch is waiting on Gutenberg robot-access rules');
  },
};

export const upstreamCatalogue: Catalogue = {
  async search(): Promise<never> {
    throw new Error('upstream not configured: catalogue search is waiting on Gutenberg robot-access rules');
  },
};
