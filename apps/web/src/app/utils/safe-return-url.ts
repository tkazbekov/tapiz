// Only same-origin paths are accepted, so ?returnUrl= can't be used as an open redirect
export function safeReturnUrl(
  value: string | null | undefined,
  fallback = '/',
): string {
  if (
    !value ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.startsWith('/\\')
  ) {
    return fallback;
  }

  try {
    const origin = window.location.origin;
    // the URL parser drops tabs/newlines, "/\t/evil.com" ends up off-origin here
    const url = new URL(value, origin);

    if (url.origin !== origin) {
      return fallback;
    }

    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}
