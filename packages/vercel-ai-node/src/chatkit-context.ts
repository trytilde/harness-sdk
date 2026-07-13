import { AsyncLocalStorage } from "node:async_hooks";
import type { JsonObject } from "@tilde/harness-sdk";

export type ChatKitConvertedMessage = {
  chatKitMessageId: string;
  message: JsonObject;
};

export type ChatKitContextClient = {
  cacheConvertedMessages(input: {
    messages: ChatKitConvertedMessage[];
  }): Promise<{ success: boolean }>;
  hydrateConvertedMessages(input: {
    messageIds: string[];
  }): Promise<{ messages: ChatKitConvertedMessage[] }>;
};

type ChatKitAsyncContext = {
  chatkit: ChatKitContextClient;
};

const chatKitContextStorage = new AsyncLocalStorage<ChatKitAsyncContext>();

export function runWithChatKitContext<T>(
  chatkit: ChatKitContextClient,
  callback: () => T,
): T {
  return chatKitContextStorage.run({ chatkit }, callback);
}

export function currentChatKitContext(): ChatKitContextClient | undefined {
  return chatKitContextStorage.getStore()?.chatkit;
}
