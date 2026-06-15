declare module "turndown" {
  export default class TurndownService {
    constructor(options?: Record<string, unknown>);
    use(plugin: unknown): void;
    turndown(html: string): string;
  }
}
