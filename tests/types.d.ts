declare module "turndown" {
  export default class TurndownService {
    constructor(options?: Record<string, unknown>);
    use(plugin: unknown): void;
    turndown(html: string): string;
  }
}

declare module "qrcode-terminal" {
  type GenerateOptions = { small?: boolean };

  const qrcode: {
    generate(input: string, options: GenerateOptions, callback: (output: string) => void): void;
    generate(input: string, callback: (output: string) => void): void;
    setErrorLevel(error: string): void;
  };

  export default qrcode;
}
