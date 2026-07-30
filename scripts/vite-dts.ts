import { existsSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { PluginOptions } from "vite-plugin-dts";

const relativeModuleSpecifier =
  /(\bfrom\s*|\bimport\s*\()\s*(["'])(\.{1,2}\/[^"']+)\2/g;
const runtimeExtension = /\.(?:[cm]?js|json|node)$/;

export function nodeEsmDeclarations(packageRoot: string): PluginOptions {
  const sourceRoot = resolve(packageRoot, "src");
  const outputRoot = resolve(packageRoot, "dist");
  return {
    beforeWriteFile(filePath, content) {
      const sourceDirectory = resolve(
        sourceRoot,
        dirname(relative(outputRoot, filePath)),
      );
      return {
        content: content.replace(
          relativeModuleSpecifier,
          (match, prefix, quote, specifier) => {
            if (runtimeExtension.test(specifier)) return match;
            const sourceTarget = resolve(sourceDirectory, specifier);
            const suffix =
              existsSync(sourceTarget) && statSync(sourceTarget).isDirectory()
                ? "/index.js"
                : ".js";
            return `${prefix}${quote}${specifier}${suffix}${quote}`;
          },
        ),
      };
    },
  };
}
