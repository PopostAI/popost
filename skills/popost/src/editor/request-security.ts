/** Local services must reject foreign Host headers, including after DNS rebinding. */
export const hostAllowed = (host: string | undefined, port: number): boolean =>
  host === `127.0.0.1:${port}` || host === `localhost:${port}`;

export const originAllowed = (headers: Readonly<Record<string, string>>, port: number): boolean =>
  hostAllowed(headers.host, port) && headers.origin === `http://${headers.host}`;
