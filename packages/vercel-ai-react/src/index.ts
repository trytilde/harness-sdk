import { useChatKit } from "@tilde/harness-sdk-react";

export {
  TildeProvider,
  type TildeProviderProps,
  useChatKit,
  useChatKitMessageHistory,
  useChatKitSessionEvents,
  useTildeClient,
} from "@tilde/harness-sdk-react";

export type UseChatKitVercelUiEndpointOptions = {
  sessionId: string;
  inboxId: string;
  instanceId: string;
  stream?: boolean;
};

export function useChatKitVercelUiEndpoint(
  options: UseChatKitVercelUiEndpointOptions,
): string {
  const chatkit = useChatKit();
  return chatkit.vercelUiEndpoint(options);
}
