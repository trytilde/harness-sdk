import {
  type SkillPackageFile as ApiSkillPackageFile,
  type SkillPackageFileDownload as ApiSkillPackageFileDownload,
  type SkillPackageManifest as ApiSkillPackageManifest,
  createGeneratedClient,
  downloadSkillPackageFile,
  type GeneratedClient,
  getSkillPackage,
  getSkillRegistry,
  getSkillRegistrySkill,
  getSkillRegistrySkillByTitle,
  type Skill,
} from "@trytilde/api-client";
import { configFetch, configHeaders, type NormalizedConfig } from "./config";

export type SkillItem = Skill;

export type SkillPackageFile = ApiSkillPackageFile;
export type SkillPackageManifest = ApiSkillPackageManifest;
export type SkillPackageFileDownload = ApiSkillPackageFileDownload;

export type MaterializedSkillPackage = {
  directory: string;
  manifest: SkillPackageManifest;
};

export class SkillPackage {
  readonly #config: NormalizedConfig;
  readonly #client: GeneratedClient;
  readonly skillId: string;

  constructor(config: NormalizedConfig, skillId: string) {
    this.#config = config;
    this.skillId = skillId;
    this.#client = createGeneratedClient({
      baseUrl: config.baseUrl,
      headers: configHeaders(config),
      fetch: configFetch(config),
      throwOnError: true,
    });
  }

  async manifest(): Promise<SkillPackageManifest> {
    const { data } = await getSkillPackage({
      client: this.#client,
      path: { team_id: this.#config.teamId, id: this.skillId },
      throwOnError: true,
    });
    return data;
  }

  async download(path: string): Promise<Uint8Array> {
    const file = await this.#downloadDescriptor(path);
    const response = await configFetch(this.#config)(file.url);
    if (!response.ok) {
      throw new Error(
        `Skill package file download failed with ${response.status}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async materialize(destination: string): Promise<MaterializedSkillPackage> {
    const [{ mkdir, mkdtemp, rename, rm, chmod, writeFile }, pathModule] =
      await Promise.all([import("node:fs/promises"), import("node:path")]);
    const manifest = await this.manifest();
    const destinationPath = pathModule.resolve(destination);
    const parent = pathModule.dirname(destinationPath);
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(pathModule.join(parent, ".tilde-skill-"));
    try {
      for (const file of manifest.files) {
        const output = pathModule.resolve(staging, file.path);
        if (!output.startsWith(`${staging}${pathModule.sep}`)) {
          throw new Error(`Unsafe skill package path: ${file.path}`);
        }
        await mkdir(pathModule.dirname(output), { recursive: true });
        const content = await this.download(file.path);
        if (content.byteLength !== file.size_bytes) {
          throw new Error(`Size mismatch for skill package file: ${file.path}`);
        }
        const checksum = await sha256Hex(content);
        if (checksum !== file.checksum_sha256) {
          throw new Error(
            `Checksum mismatch for skill package file: ${file.path}`,
          );
        }
        await writeFile(output, content, { flag: "wx" });
        if (file.executable) {
          await chmod(output, 0o755);
        }
      }
      await rename(staging, destinationPath);
      return { directory: destinationPath, manifest };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async #downloadDescriptor(path: string): Promise<SkillPackageFileDownload> {
    const { data } = await downloadSkillPackageFile({
      client: this.#client,
      path: { team_id: this.#config.teamId, id: this.skillId },
      body: { path },
      throwOnError: true,
    });
    return data;
  }
}

async function sha256Hex(content: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(content),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

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

  package(skillId: string): SkillPackage {
    return new SkillPackage(this.#config, skillId);
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
