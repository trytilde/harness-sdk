import { ChatKitClient, MessagesClient } from "./chatkit";
import type { Config } from "./config";
import { createConfig, type NormalizedConfig } from "./config";
import { McpClient } from "./tools";
import {
  type LocalRuntimeTunnelProcess,
  startLocalRuntimeTunnel,
} from "./tunnel";

export class Client {
  readonly config: NormalizedConfig;
  readonly mcp: McpClient;
  readonly chatkit: ChatKitClient;
  readonly messages: MessagesClient;
  readonly localRuntimeTunnel?: Promise<LocalRuntimeTunnelProcess>;

  constructor(config: Config) {
    this.config = createConfig(config);
    this.messages = new MessagesClient(this.config);
    this.mcp = new McpClient(this.config);
    this.chatkit = new ChatKitClient(this.config, this.messages);
    if (this.config.tunnel) {
      const localRuntimeTunnel = startLocalRuntimeTunnel(this.config);
      localRuntimeTunnel.catch((error) => {
        console.error("Failed to start local runtime tunnel", error);
      });
      this.localRuntimeTunnel = localRuntimeTunnel;
    }
  }
}

export function createClient(config: Config): Client {
  return new Client(config);
}
