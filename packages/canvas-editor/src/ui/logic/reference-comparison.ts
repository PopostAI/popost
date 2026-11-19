import type { ProjectImage } from '../../host/project-tools';

/** Local references follow persistent page keys. The web host associates references by position. */
export const referenceForPage = (images: readonly ProjectImage[], index: number, pageKey?: string | null): ProjectImage | null =>
  images.some((image) => image.pageKey !== undefined)
    ? images.find((image) => image.pageKey === pageKey) ?? null
    : images[index] ?? null;
