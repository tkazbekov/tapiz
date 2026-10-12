// Last guest name used on this browser, prefills the join form after a session ends
const key = 'tapiz.guestNameHint';

export function readGuestNameHint(): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    // storage can be blocked
    return '';
  }
}

export function writeGuestNameHint(name: string) {
  try {
    localStorage.setItem(key, name);
  } catch {
    // storage can be blocked
  }
}
