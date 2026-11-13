/** The request finished and its controller-side cleanup was confirmed. */
export class ImageRuntimeRequestError extends Error {
  readonly cleanupConfirmed = true;
  constructor(message = 'Image runtime request failed') { super(message); this.name = 'ImageRuntimeRequestError'; }
}

/** The cancelled request finished and its controller-side cleanup was confirmed. */
export class ImageRuntimeCancelledError extends ImageRuntimeRequestError {
  constructor() { super('Image runtime request cancelled'); this.name = 'ImageRuntimeCancelledError'; }
}

/** The caller cannot establish that a submitted request was fully cleaned up. */
export class ImageRuntimeUncertainError extends Error {
  constructor(message = 'Image runtime cleanup is uncertain') { super(message); this.name = 'ImageRuntimeUncertainError'; }
}
