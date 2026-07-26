import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GithubReadSettings {
  readonly security: boolean;
  readonly notifications: boolean;
}

const DISABLED: GithubReadSettings = { security: false, notifications: false };

export async function loadGithubReadSettings(
  path = join(homedir(), ".pi", "agent", "settings.json"),
): Promise<GithubReadSettings> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      extensionSettings?: { githubRead?: { security?: unknown; notifications?: unknown } };
    };
    const config = parsed.extensionSettings?.githubRead;
    return {
      security: config?.security === true,
      notifications: config?.notifications === true,
    };
  } catch {
    return DISABLED;
  }
}
