/** All public debug services use the current origin. */
export function wsEndpoints(): string[] {
  const url = new URL('/ws', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return [url.href];
}
export const wtUrl = () => new URL('/wt', location.href).href;
