import fs from 'node:fs';
import path from 'node:path';

/**
 * Idempotently seeds Pi & Gentle-Shell provider configuration so pidev works
 * standalone against Bifrost even on a freshly provisioned LocalStorage volume.
 */
function ensureJsonIfMissing(filePath, data) {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

const baseUrl = process.env.OPENAI_BASE_URL || 'http://bifrost:8080/v1';
const apiKey = process.env.OPENAI_API_KEY || 'vk-pidev';

const modelsConfig = {
  $schema: 'https://pi.dev/schemas/models.schema.json',
  providers: {
    bifrost: {
      baseUrl,
      api: 'openai-completions',
      apiKey,
      models: [
        { id: 'auto' },
        { id: 'deepseek-chat' },
        { id: 'deepseek-flash' },
        { id: 'deepseek-v4-pro' },
        { id: 'gpt-4o-mini' },
      ],
    },
    deepseek: { baseUrl },
    openai: { baseUrl },
  },
};

const authConfig = {
  openai: { type: 'api_key', key: apiKey },
  deepseek: { type: 'api_key', key: apiKey },
};

const settingsConfig = {
  tuiMode: 'fullscreen',
  theme: 'Gentleman-Cute',
  extensions: ['-builtin:codemode'],
};

for (const dir of [
  process.env.PI_CODING_AGENT_DIR || '/mnt/localstorage/pidev/pi',
  process.env.GENTLE_SHELL_HOME || '/mnt/localstorage/pidev/gentle-shell',
]) {
  ensureJsonIfMissing(path.join(dir, 'models.json'), modelsConfig);
  ensureJsonIfMissing(path.join(dir, 'auth.json'), authConfig);
}

ensureJsonIfMissing(
  path.join(process.env.GENTLE_SHELL_HOME || '/mnt/localstorage/pidev/gentle-shell', 'settings.json'),
  settingsConfig,
);
