/**
 * Turns what a user typed as a link into an href the rich-text sanitizer
 * keeps (http(s), mailto and tel), or '' when it can't be linked.
 * Without a scheme the text is taken as a web address: `example.com` and
 * `localhost:4300/board` become https links.
 */
export function normalizeLinkUrl(url: string): string {
  const trimmedUrl = url.trim();

  if (!trimmedUrl) {
    return '';
  }

  if (/^(?:https?:\/\/|mailto:|tel:)\S/i.test(trimmedUrl)) {
    return trimmedUrl;
  }

  // any other scheme (javascript:, data:, ...); `host:port` is not a scheme
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmedUrl)) {
    return '';
  }

  // relative and protocol-relative links are not kept by the sanitizer
  if (/^[/\\#?]/.test(trimmedUrl)) {
    return '';
  }

  return `https://${trimmedUrl}`;
}
