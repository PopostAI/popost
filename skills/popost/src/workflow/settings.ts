/** `settings`: platform, language and the image channel of a project (shared by the `settings` command and `setup`). */
import type { Project } from '../core/project';

export const PLATFORMS = ['tiktok', 'xiaohongshu', 'instagram', 'douyin', 'x'] as const;
export const CHANNELS = ['official', 'host', 'custom'] as const;

export interface SettingsChange {
  readonly platform?: string;
  readonly language?: string;
  readonly channel?: string;
  readonly model?: string;
}

type Provider = Project['manifest']['provider'];

/** A value that is empty (or absent) leaves the setting as it is. */
const given = (value: string | undefined): value is string => Boolean(value);

/** Whether `applySettings(project, change)` would change anything. */
export const settingsDiffer = (project: Project, change: SettingsChange): boolean => {
  const { manifest } = project;
  return (
    (given(change.platform) && manifest.platform !== change.platform) ||
    (given(change.language) && manifest.language !== change.language) ||
    (given(change.channel) && manifest.provider?.channel !== change.channel) ||
    (given(change.model) && manifest.provider?.model !== change.model)
  );
};

/** Applies the given settings and saves the manifest; returns the project's image provider. */
export const applySettings = async (project: Project, change: SettingsChange): Promise<Provider> => {
  const { manifest } = project;
  if (given(change.platform)) manifest.platform = change.platform;
  if (given(change.language)) manifest.language = change.language;
  const provider = (manifest.provider ??= { channel: 'official', model: null });
  if (given(change.channel)) provider.channel = change.channel;
  if (given(change.model)) provider.model = change.model;
  await project.saveManifest();
  return provider;
};
