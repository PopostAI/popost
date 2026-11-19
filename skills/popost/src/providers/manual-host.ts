/** Manual source inventory and host capability declarations (port of providers/manual_host.py): nothing is generated. */
import { createHash } from 'node:crypto';
import { msg } from '../i18n';
import { BaseImageProvider, type CheckResult, type JsonRecord, type ModelRow } from './base';
import { ImageProviderError } from './errors';

export const MANUAL_NAME = 'manual';
export const HOST_NAME = 'host';

export class ManualProvider extends BaseImageProvider {
  readonly name = MANUAL_NAME;
  override readonly generative = false;

  async models(): Promise<ModelRow[]> {
    return [{ value: 'user-supplied', label: msg('assets supplied by the user', '用户直接提供的素材'), credits: 0, known: true }];
  }

  // Offline: any existing local file in a request counts as available.
  async check(): Promise<CheckResult> {
    return [true, false, msg('manual: the user supplies the assets directly; no API, no cost, not tested over the network', 'manual：素材由用户直接提供，无 API、无费用、未联网实测')];
  }

  /** Registers files the user supplied: existence and content sha256; a missing file is an error, never invented. */
  async inventory(files: readonly string[]): Promise<JsonRecord[]> {
    const items: JsonRecord[] = [];
    for (const file of files) {
      const abs = this.rt.path.resolve(this.rt.cwd, file);
      if (!(await this.rt.fs.stat(abs))?.isFile) throw new ImageProviderError(msg(`the manual asset file does not exist: ${file}`, `manual 素材文件不存在: ${file}`));
      items.push({ kind: 'local', value: abs, sha256: createHash('sha256').update(await this.rt.fs.readFile(abs)).digest('hex') });
    }
    return items;
  }
}

export class HostProvider extends BaseImageProvider {
  readonly name = HOST_NAME;
  override readonly generative = false;

  async models(): Promise<ModelRow[]> {
    return [];
  }

  async check(): Promise<CheckResult> {
    const declared = Boolean(this.config.declared);
    return [
      declared,
      false,
      declared
        ? msg(
            'host: the host declared this capability (declared); this Skill neither calls it, nor tests it, nor charges for it',
            'host：宿主已声明具备该能力（declared），本技能未代调、未实测、不计费',
          )
        : msg(
            'host: the host has not declared this capability, so do not assume it is there; when needed, the host supplies the assets itself',
            'host：宿主未声明该能力，不可假定可用；需要时由宿主自行提供素材',
          ),
    ];
  }
}
