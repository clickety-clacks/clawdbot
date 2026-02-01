export class ClientMessageError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
