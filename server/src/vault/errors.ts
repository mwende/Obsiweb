export type VaultErrorCode =
  | 'BAD_PATH'
  | 'NOT_FOUND'
  | 'EXISTS'
  | 'PRECONDITION'
  | 'IS_DIR'
  | 'NOT_DIR'
  | 'PARENT_MISSING'
  | 'TOO_LARGE'
  | 'FORBIDDEN';

export class VaultError extends Error {
  constructor(
    public readonly code: VaultErrorCode,
    message: string,
    public readonly currentEtag?: string | null,
  ) {
    super(message);
  }
}

export function httpStatusFor(code: VaultErrorCode): number {
  switch (code) {
    case 'BAD_PATH':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'EXISTS':
    case 'PRECONDITION':
      return 412;
    case 'IS_DIR':
    case 'NOT_DIR':
    case 'PARENT_MISSING':
      return 409;
    case 'TOO_LARGE':
      return 413;
    case 'FORBIDDEN':
      return 403;
  }
}
