export class LayerfsError extends Error {
  code: string;
  detail: unknown;
  constructor(code: string, message: string, detail: unknown = null) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
