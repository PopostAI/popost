/**
 * The CPU budget: how many processors the CLI's work may keep busy at once. Everything that decides how much runs at
 * once (ffmpeg's threads, Chrome pages, a tool's threads, parts that run side by side) derives from this one number,
 * and nothing asks the machine for its processor count: on a shared host or in a container limited by a CPU quota,
 * the machine's count is the host's, and work sized by it oversubscribes the processors the process really has.
 *
 * The rule, without the machine: POPOST_CPUS when it is a whole number from 1; else the smaller of the processor
 * affinity of the process and the CPU quota of its control group (cgroup v2 `cpu.max`, cgroup v1
 * `cpu.cfs_quota_us` / `cpu.cfs_period_us`, on its own group and every group above it), rounded up, at least 1.
 * The runtime reads the files (node-runtime.ts) and passes them in, so the rule is tested with made-up ones.
 */

export interface CpuBudget {
  /** Whole processors, at least 1. */
  readonly cpus: number;
  /** Where the number came from, as doctor prints it. */
  readonly source: string;
}

/** What the place the CLI runs in says about its processors. */
export interface CpuFacts {
  /** Processors this process may run on: its affinity, or the count the platform reports where there is no mask. */
  readonly affinity: number;
  /** The contents of /proc/self/cgroup; undefined where there is none (not Linux). */
  readonly cgroup?: string;
  /** A file under the cgroup mount (/sys/fs/cgroup), by its path below the mount; undefined when it cannot be read. */
  readonly readCgroupFile: (path: string) => string | undefined;
}

/** POPOST_CPUS as a whole number from 1, or undefined when it is unset or not one. */
export const askedCpus = (value: string | undefined): number | undefined => {
  const t = value?.trim() ?? '';
  return /^[0-9]+$/.test(t) && Number(t) >= 1 ? Number(t) : undefined;
};

/** The number of processors in a Linux CPU list such as "0-3,8,10-11" (6); 0 when it is not one. */
export const countCpuList = (list: string): number =>
  list.trim().split(',').reduce((n, part) => {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return n;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    return to >= from ? n + to - from + 1 : n;
  }, 0);

/** The group's directory and every one above it, up to the mount's root (""), innermost first. */
const groupAndAncestors = (group: string): string[] => {
  const parts = group.split('/').filter(Boolean);
  return Array.from({ length: parts.length + 1 }, (_, k) => parts.slice(0, parts.length - k).join('/'));
};

/** A path below the cgroup mount from its parts; empty parts (the root group) are left out. */
const below = (...parts: string[]): string => parts.filter(Boolean).join('/');

/** Processors a cgroup v2 cpu.max allows ("150000 100000" is 1.5); undefined for "max" or an unreadable value. */
export const cpuMaxQuota = (text: string | undefined): number | undefined => {
  const [quota, period] = (text ?? '').trim().split(/\s+/);
  const q = Number(quota), p = Number(period);
  return quota !== 'max' && q > 0 && p > 0 ? q / p : undefined;
};

/** Processors a cgroup v1 quota and period allow; undefined for no quota (-1) or unreadable values. */
export const cfsQuota = (quotaText: string | undefined, periodText: string | undefined): number | undefined => {
  const q = Number(quotaText?.trim()), p = Number(periodText?.trim());
  return quotaText !== undefined && periodText !== undefined && q > 0 && p > 0 ? q / p : undefined;
};

interface Quota { readonly cpus: number; readonly from: string }

const smallest = (quotas: readonly Quota[]): Quota | undefined =>
  quotas.reduce<Quota | undefined>((best, q) => (best === undefined || q.cpus < best.cpus ? q : best), undefined);

/** The tightest quota of the process's cgroup v2 group and the groups above it. */
const v2Quota = (facts: CpuFacts, group: string): Quota | undefined =>
  smallest(groupAndAncestors(group).flatMap((dir) => {
    const cpus = cpuMaxQuota(facts.readCgroupFile(below(dir, 'cpu.max')));
    return cpus === undefined ? [] : [{ cpus, from: 'cgroup v2 cpu.max' }];
  }));

/** Where cgroup v1 mounts the cpu controller, by the names distributions use. */
const V1_MOUNTS = ['cpu,cpuacct', 'cpuacct,cpu', 'cpu'];

/** The tightest quota of the process's cgroup v1 cpu group and the groups above it. */
const v1Quota = (facts: CpuFacts, group: string): Quota | undefined =>
  smallest(V1_MOUNTS.flatMap((mount) => groupAndAncestors(group).flatMap((dir) => {
    const at = (file: string): string | undefined => facts.readCgroupFile(below(mount, dir, file));
    const cpus = cfsQuota(at('cpu.cfs_quota_us'), at('cpu.cfs_period_us'));
    return cpus === undefined ? [] : [{ cpus, from: 'cgroup v1 cpu.cfs_quota_us' }];
  })));

/** The CPU quota of the process's control groups, or undefined when there is none. */
export const cgroupQuota = (facts: CpuFacts): Quota | undefined => {
  const lines = (facts.cgroup ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const quotas = lines.flatMap((line) => {
    const [, controllers = '', group = ''] = line.match(/^\d+:([^:]*):(.*)$/) ?? [];
    if (controllers === '') return [v2Quota(facts, group)];
    return controllers.split(',').includes('cpu') ? [v1Quota(facts, group)] : [];
  });
  return smallest(quotas.filter((q): q is Quota => q !== undefined));
};

const round = (n: number): string => String(Math.round(n * 100) / 100);

/** The budget, by the rule at the top of this file. */
export const cpuBudget = (asked: string | undefined, facts: CpuFacts): CpuBudget => {
  const wanted = askedCpus(asked);
  if (wanted !== undefined) return { cpus: wanted, source: 'POPOST_CPUS' };
  const ignored = asked?.trim() ? ' (POPOST_CPUS "' + asked.trim().slice(0, 20) + '" ignored: not a whole number from 1)' : '';
  const affinity = Math.max(1, Math.floor(facts.affinity));
  const quota = cgroupQuota(facts);
  if (quota && Math.ceil(quota.cpus) < affinity)
    return { cpus: Math.max(1, Math.ceil(quota.cpus)), source: quota.from + ': ' + round(quota.cpus) + (quota.cpus === 1 ? ' processor' : ' processors') + (Number.isInteger(quota.cpus) ? '' : ', rounded up') + ignored };
  return { cpus: affinity, source: 'affinity: the processors this process may run on' + ignored };
};
