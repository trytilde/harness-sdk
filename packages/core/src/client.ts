import { AiGatewayClient } from "./ai-gateway";
import { ChatKitClient } from "./chatkit";
import type { Config } from "./config";
import { createConfig, type NormalizedConfig } from "./config";
import { McpClient } from "./mcp";
import { MessagesClient } from "./messages";

export class Client {
  readonly config: NormalizedConfig;
  readonly aiGateway: AiGatewayClient;
  readonly mcp: McpClient;
  readonly chatkit: ChatKitClient;
  readonly messages: MessagesClient;

  constructor(config: Config) {
    this.config = createConfig(config);
    this.messages = new MessagesClient(this.config);
    this.aiGateway = new AiGatewayClient(this.config);
    this.mcp = new McpClient(this.config);
    this.chatkit = new ChatKitClient(this.config, this.messages);
  }
}

export function createClient(config: Config): Client {
  return new Client(config);
}
