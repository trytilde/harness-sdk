import { AgentsClient } from "./agents";
import { ChatKitClient, MessagesClient } from "./chatkit";
import type { Config } from "./config";
import { createConfig, type NormalizedConfig } from "./config";
import { McpClient } from "./tools";

export class Client {
  readonly config: NormalizedConfig;
  readonly mcp: McpClient;
  readonly agents: AgentsClient;
  readonly chatkit: ChatKitClient;
  readonly messages: MessagesClient;

  constructor(config: Config) {
    this.config = createConfig(config);
    this.messages = new MessagesClient(this.config);
    this.mcp = new McpClient(this.config);
    this.agents = new AgentsClient(this.config);
    this.chatkit = new ChatKitClient(this.config, this.messages);
  }
}

export function createClient(config: Config): Client {
  return new Client(config);
}
