import { CompletionContext, CompletionProvider } from "./completion-provider";

/** Deterministic stand-in for AI; customize the response for demos or integration tests. */
export class FakeCompletionProvider implements CompletionProvider {
  constructor(private readonly text: string | null = " suggested text to try.\nA second suggested line.") {}

  async complete(_context: CompletionContext): Promise<string | null> {
    return this.text;
  }
}
