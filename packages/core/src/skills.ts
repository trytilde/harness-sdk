import {
  createGeneratedClient,
  type GeneratedClient,
  getSkillRegistry,
  getSkillRegistrySkill,
  getSkillRegistrySkillByTitle,
  type Skill,
} from "@tilde/api-client";
import { configFetch, configHeaders, type NormalizedConfig } from "./config";

export type SkillItem = Skill;

export type SkillRegistry = {
  id: string;
  list(): Promise<SkillItem[]>;
  find(skillIdOrName: string): Promise<SkillItem>;
};

export class SkillsClient {
  readonly #config: NormalizedConfig;
  readonly #client: GeneratedClient;

  constructor(config: NormalizedConfig) {
    this.#config = config;
    this.#client = createGeneratedClient({
      baseUrl: config.baseUrl,
      headers: configHeaders(config),
      fetch: configFetch(config),
      throwOnError: true,
    });
  }

  async registry(registryId: string): Promise<SkillRegistry> {
    const { data: registry } = await getSkillRegistry({
      client: this.#client,
      path: { team_id: this.#config.teamId, id: registryId },
      throwOnError: true,
    });
    const skills = registry.skills;
    const client = this.#client;
    const teamId = this.#config.teamId;

    return {
      id: registry.id,
      async list() {
        return skills;
      },
      async find(skillIdOrName) {
        if (skills.some((skill) => skill.id === skillIdOrName)) {
          const { data: skill } = await getSkillRegistrySkill({
            client,
            path: {
              team_id: teamId,
              id: registryId,
              skill_id: skillIdOrName,
            },
            throwOnError: true,
          });
          return skill;
        }

        const { data: skill } = await getSkillRegistrySkillByTitle({
          client,
          path: {
            team_id: teamId,
            id: registryId,
            title: skillIdOrName,
          },
          throwOnError: true,
        });
        return skill;
      },
    };
  }
}
