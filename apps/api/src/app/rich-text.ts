import createDOMPurify, { type WindowLike } from 'dompurify';
import { JSDOM } from 'jsdom';
import type { StateActions } from '@tapiz/board-commons';
import {
  createRichTextSanitizer,
  sanitizeStateActionRichText,
  type RichTextSanitizer,
} from '@tapiz/board-commons/rich-text/rich-text-sanitizer.js';

// DOMPurify needs a DOM in node; one jsdom window is created lazily and reused
// for every message (it sits on the websocket hot path).
let sanitizer: RichTextSanitizer | null = null;

export function sanitizeRichText(html: string) {
  if (!sanitizer) {
    const { window } = new JSDOM('');

    sanitizer = createRichTextSanitizer(
      createDOMPurify(window as unknown as WindowLike),
    );
  }

  return sanitizer(html);
}

export function sanitizeStateActions(actions: StateActions[]) {
  return actions.map((action) =>
    sanitizeStateActionRichText(action, sanitizeRichText),
  );
}
