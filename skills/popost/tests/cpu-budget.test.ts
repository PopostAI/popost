/** The CPU budget's rule (src/cpu-budget.ts) with made-up affinities and cgroup files: nothing here reads the machine. */
import { describe, expect, it } from 'vitest';
import { askedCpus, cfsQuota, cgroupQuota, countCpuList, cpuBudget, cpuMaxQuota, type CpuFacts } from '../src/cpu-budget';

/** Facts with the given affinity, /proc/self/cgroup and files under the cgroup mount. */
const facts = (affinity: number, cgroup?: string, files: Record<string, string> = {}): CpuFacts => ({
  affinity,
  ...(cgroup === undefined ? {} : { cgroup }),
  readCgroupFile: (path) => files[path],
});

describe('the parts of the rule', () => {
  it('takes POPOST_CPUS only as a whole number from 1', () => {
    expect(askedCpus('2')).toBe(2);
    expect(askedCpus(' 16 ')).toBe(16);
    for (const bad of [undefined, '', '0', '-1', '1.5', 'two', '2x']) expect(askedCpus(bad), String(bad)).toBeUndefined();
  });

  it('counts a Linux CPU list', () => {
    expect(countCpuList('0-15')).toBe(16);
    expect(countCpuList('8-15')).toBe(8);
    expect(countCpuList('0-3,8,10-11')).toBe(7);
    expect(countCpuList('3')).toBe(1);
    expect(countCpuList('')).toBe(0);
    expect(countCpuList('junk')).toBe(0);
  });

  it('reads a cgroup v2 cpu.max and a cgroup v1 quota and period as processors', () => {
    expect(cpuMaxQuota('150000 100000\n')).toBe(1.5);
    expect(cpuMaxQuota('max 100000')).toBeUndefined();
    expect(cpuMaxQuota(undefined)).toBeUndefined();
    expect(cpuMaxQuota('garbage')).toBeUndefined();
    expect(cfsQuota('200000\n', '100000\n')).toBe(2);
    expect(cfsQuota('-1', '100000')).toBeUndefined();
    expect(cfsQuota(undefined, '100000')).toBeUndefined();
  });
});

describe('the budget', () => {
  it('is POPOST_CPUS when it is set, whatever the machine says', () => {
    expect(cpuBudget('3', facts(16, '0::/a', { 'a/cpu.max': '100000 100000' }))).toEqual({ cpus: 3, source: 'POPOST_CPUS' });
  });

  it('is the affinity where there is no quota (no cgroup at all, or "max" everywhere)', () => {
    expect(cpuBudget(undefined, facts(6))).toEqual({ cpus: 6, source: 'affinity: the processors this process may run on' });
    expect(cpuBudget(undefined, facts(6, '0::/user.slice/a.scope', { 'cpu.max': 'max 100000', 'user.slice/cpu.max': 'max 100000' })).cpus).toBe(6);
  });

  it('is a cgroup v2 quota rounded up, read on the group or any group above it, the tightest one', () => {
    const v2 = '0::/user.slice/app.slice/run-1.scope\n';
    // The scope has no cpu.max of its own (the controller is not enabled there); its parent slice has one.
    expect(cpuBudget(undefined, facts(16, v2, { 'user.slice/app.slice/cpu.max': '150000 100000' }))).toEqual({ cpus: 2, source: 'cgroup v2 cpu.max: 1.5 processors, rounded up' });
    expect(cpuBudget(undefined, facts(16, v2, { 'user.slice/app.slice/run-1.scope/cpu.max': '400000 100000', 'user.slice/cpu.max': '50000 100000' })).cpus).toBe(1);
    // In a container the group is "/" and the quota is the mount's own.
    expect(cpuBudget(undefined, facts(64, '0::/\n', { 'cpu.max': '200000 100000' }))).toEqual({ cpus: 2, source: 'cgroup v2 cpu.max: 2 processors' });
    expect(cpuBudget(undefined, facts(64, '0::/\n', { 'cpu.max': '100000 100000' })).source).toBe('cgroup v2 cpu.max: 1 processor');
  });

  it('is the affinity when that is smaller than the quota', () => {
    expect(cpuBudget(undefined, facts(2, '0::/a', { 'a/cpu.max': '800000 100000' }))).toEqual({ cpus: 2, source: 'affinity: the processors this process may run on' });
  });

  it('reads a cgroup v1 quota under the mount names distributions use, and ignores the other controllers', () => {
    const v1 = '12:memory:/docker/abc\n4:cpu,cpuacct:/docker/abc\n1:name=systemd:/docker/abc\n';
    expect(cpuBudget(undefined, facts(32, v1, { 'cpu,cpuacct/docker/abc/cpu.cfs_quota_us': '250000', 'cpu,cpuacct/docker/abc/cpu.cfs_period_us': '100000' })))
      .toEqual({ cpus: 3, source: 'cgroup v1 cpu.cfs_quota_us: 2.5 processors, rounded up' });
    // Inside the container the mount shows the container's own group at its root.
    expect(cpuBudget(undefined, facts(32, v1, { 'cpu/cpu.cfs_quota_us': '100000', 'cpu/cpu.cfs_period_us': '100000' })).cpus).toBe(1);
    expect(cpuBudget(undefined, facts(32, '12:memory:/x\n', { 'cpu/cpu.cfs_quota_us': '100000', 'cpu/cpu.cfs_period_us': '100000' })).cpus).toBe(32);
  });

  it('is at least one processor, and says so when POPOST_CPUS is not a number it can use', () => {
    expect(cpuBudget(undefined, facts(0)).cpus).toBe(1);
    expect(cpuBudget(undefined, facts(4, '0::/', { 'cpu.max': '1000 100000' })).cpus).toBe(1);
    const ignored = cpuBudget('0', facts(4));
    expect(ignored.cpus).toBe(4);
    expect(ignored.source).toContain('POPOST_CPUS "0" ignored');
  });

  it('finds no quota in an unreadable or empty cgroup listing', () => {
    expect(cgroupQuota(facts(8, ''))).toBeUndefined();
    expect(cgroupQuota(facts(8, 'not a cgroup line'))).toBeUndefined();
  });
});
