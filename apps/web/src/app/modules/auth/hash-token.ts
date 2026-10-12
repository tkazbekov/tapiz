// Links carry the token in the fragment so it never reaches server logs or
// the Referer header. Read it once and drop it from the address bar/history.
export function takeHashToken(document: Document): string | null {
  const { location } = document;
  const token = new URLSearchParams(location.hash.slice(1)).get('token');

  if (location.hash) {
    const history = document.defaultView?.history;

    history?.replaceState(
      history.state,
      '',
      location.pathname + location.search,
    );
  }

  return token;
}
