import { randomUUID } from "node:crypto";

type MetadataContext = {
  contextKey: string;
  generation: string;
};

export class ClawlineMetadataContextGenerations {
  private readonly contexts = new Map<string, MetadataContext>();

  constructor(private readonly createGeneration: () => string = randomUUID) {}

  resolve(sessionKey: string, contextKey: string): string {
    const current = this.contexts.get(sessionKey);
    if (current?.contextKey === contextKey) {
      return current.generation;
    }
    const generation = this.createGeneration();
    this.contexts.set(sessionKey, { contextKey, generation });
    return generation;
  }
}
