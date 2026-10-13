import type { Config, DOMPurify } from 'dompurify';

import type { StateActions, TuNode } from '../models/node.model.js';

// Shared rich-text policy for the browser (DOMPurify on window) and the API
// (DOMPurify on a jsdom window). It mirrors what the tiptap editors in
// libs/ui produce: paragraphs, h1-h3, bold/italic/strike, lists, links,
// mentions and TextStyleKit/TextAlign inline styles.

const ALLOWED_TAGS = [
  'p',
  'br',
  'h1',
  'h2',
  'h3',
  'strong',
  'b',
  'em',
  'i',
  's',
  'strike',
  'del',
  'u',
  'ul',
  'ol',
  'li',
  'a',
  'span',
];

// Non-URL attributes. DOMPurify checks every attribute that is not
// "URI safe" against ALLOWED_URI_REGEXP, so these are also listed as URI safe
// to keep `href` the only attribute matched against the http(s)/mailto/tel regex.
const PLAIN_ATTR = [
  'target',
  'rel',
  'start',
  'type',
  // tiptap mention: <span data-type="mention" data-id data-label ...>
  'data-type',
  'data-id',
  'data-label',
  'data-mention-suggestion-char',
];

export const RICH_TEXT_SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS,
  ALLOWED_ATTR: ['href', 'style', ...PLAIN_ATTR],
  ADD_URI_SAFE_ATTR: PLAIN_ATTR,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  // keep in step with normalizeLinkUrl (rich-text-link.ts)
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:)/i,
};

const LINK_REL = 'noopener noreferrer nofollow';

const cssColor =
  /^(?:#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\(\s*[\d.]+%?\s*(?:,\s*[\d.]+%?\s*){2,3}\)|hsla?\(\s*[\d.]+(?:deg)?\s*(?:,\s*[\d.]+%?\s*){2,3}\))$/i;

const ALLOWED_STYLES: Record<string, RegExp> = {
  color: cssColor,
  'background-color': cssColor,
  'font-family': /^[\w\s"',-]{1,200}$/,
  'font-size': /^\d{1,3}(?:\.\d+)?(?:px|pt|em|rem|%)$/i,
  'line-height': /^(?:normal|\d{1,3}(?:\.\d+)?(?:px|em|rem|%)?)$/i,
  'text-align': /^(?:left|right|center|justify|start|end)$/i,
};

/**
 * Keeps only allowlisted inline style declarations with strictly matched
 * values (no url(), expression(), escapes or comments).
 */
export function sanitizeStyle(style: string): string {
  return style
    .split(';')
    .map((declaration) => {
      const separator = declaration.indexOf(':');

      if (separator === -1) {
        return null;
      }

      const property = declaration.slice(0, separator).trim().toLowerCase();
      const value = declaration.slice(separator + 1).trim();
      const pattern = ALLOWED_STYLES[property];

      if (!pattern || !pattern.test(value)) {
        return null;
      }

      return `${property}: ${value}`;
    })
    .filter((declaration): declaration is string => !!declaration)
    .join('; ');
}

export type RichTextSanitizer = (html: string) => string;

/**
 * Configures a dedicated DOMPurify instance (hooks are per instance) and
 * returns a sanitizer that applies the rich-text policy.
 */
export function createRichTextSanitizer(purify: DOMPurify): RichTextSanitizer {
  purify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName !== 'style') {
      return;
    }

    const style = sanitizeStyle(data.attrValue);

    if (style) {
      data.attrValue = style;
    } else {
      data.keepAttr = false;
    }
  });

  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'A') {
      return;
    }

    if (node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', LINK_REL);
    } else {
      node.removeAttribute('target');
      node.removeAttribute('rel');
    }
  });

  return (html: string) => {
    if (!html) {
      return '';
    }

    return purify.sanitize(html, RICH_TEXT_SANITIZE_CONFIG);
  };
}

function sanitizeContent(
  type: string,
  content: unknown,
  sanitize: RichTextSanitizer,
): unknown {
  if (!content || typeof content !== 'object') {
    return content;
  }

  const record = content as Record<string, unknown>;

  if (
    (type === 'text' || type === 'note' || type === 'panel') &&
    typeof record['text'] === 'string'
  ) {
    return { ...record, text: sanitize(record['text']) };
  }

  if (type === 'estimation.config' && Array.isArray(record['stories'])) {
    return {
      ...record,
      stories: record['stories'].map((story: unknown) => {
        if (
          story &&
          typeof story === 'object' &&
          typeof (story as Record<string, unknown>)['description'] === 'string'
        ) {
          const typedStory = story as Record<string, unknown>;

          return {
            ...typedStory,
            description: sanitize(typedStory['description'] as string),
          };
        }

        return story;
      }),
    };
  }

  return content;
}

/**
 * Sanitizes every rich-text field of a node (and its children) that the web
 * app renders as HTML.
 */
export function sanitizeNodeRichText<T extends Partial<TuNode>>(
  node: T,
  sanitize: RichTextSanitizer,
): T {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') {
    return node;
  }

  const result: T = { ...node };

  if ('content' in node) {
    result.content = sanitizeContent(
      node.type,
      node.content,
      sanitize,
    ) as T['content'];
  }

  if (Array.isArray(node.children)) {
    result.children = node.children.map((child) =>
      sanitizeNodeRichText(child, sanitize),
    );
  }

  return result;
}

export function sanitizeStateActionRichText(
  action: StateActions,
  sanitize: RichTextSanitizer,
): StateActions {
  if (action.op === 'remove') {
    return action;
  }

  return {
    ...action,
    data: sanitizeNodeRichText(action.data, sanitize),
  } as StateActions;
}
