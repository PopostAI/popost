/** Failures of the cloud sync that the platform did not report itself; `code` is what the editor and the CLI show. */
export class CloudError extends Error {
  override name = 'CloudError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
