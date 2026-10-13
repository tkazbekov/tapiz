import DOMPurify from 'dompurify';
import {
  createRichTextSanitizer,
  type RichTextSanitizer,
} from '@tapiz/board-commons/rich-text/rich-text-sanitizer';

let sanitizer: RichTextSanitizer | null = null;

/**
 * Sanitizes user rich text (notes, texts, panels, estimation stories) before
 * it reaches innerHTML. Uses its own DOMPurify instance so the policy hooks do
 * not leak into other DOMPurify users.
 */
export function sanitizeRichText(html: string | null | undefined): string {
  if (!sanitizer) {
    sanitizer = createRichTextSanitizer(DOMPurify(window));
  }

  return sanitizer(html ?? '');
}
