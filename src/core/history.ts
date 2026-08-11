import { App } from "obsidian";

export interface TikzHistoryEntry {
  source: string;
  timestamp: number;
}

export class TikzHistoryStore {
  private readonly keyPrefix = "tikz-renderer:history:";

  constructor(private readonly app: App, private readonly getLimit: () => number) {}

  list(blockKey: string): TikzHistoryEntry[] {
    const raw = this.app.loadLocalStorage(this.keyPrefix + blockKey);
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is TikzHistoryEntry =>
      typeof entry === "object" && entry !== null && typeof entry.source === "string" && typeof entry.timestamp === "number",
    );
  }

  record(blockKey: string, source: string): TikzHistoryEntry[] {
    const current = this.list(blockKey);
    if (current[0]?.source === source) return current;
    const next = [{ source, timestamp: Date.now() }, ...current].slice(0, Math.max(1, this.getLimit()));
    this.app.saveLocalStorage(this.keyPrefix + blockKey, next);
    return next;
  }
}
