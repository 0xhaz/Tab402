import type { ChannelState } from "@tab402/core";

/** Where the client keeps its per-seller channel state (seq and recorded total). */
export interface ChannelStore {
  get(sellerId: string): Promise<ChannelState | undefined> | ChannelState | undefined;
  set(sellerId: string, state: ChannelState): Promise<void> | void;
}

export class MemoryChannelStore implements ChannelStore {
  private readonly channels = new Map<string, ChannelState>();
  get(sellerId: string): ChannelState | undefined {
    return this.channels.get(sellerId);
  }
  set(sellerId: string, state: ChannelState): void {
    this.channels.set(sellerId, state);
  }
}
