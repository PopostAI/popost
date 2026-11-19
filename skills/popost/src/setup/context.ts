/** What every `setup` step and check shares: the spec, where it lives, and the project once it exists. */
import type { Project } from '../core/project';
import { isFile } from '../core/util';
import type { Runtime } from '../runtime';
import type { ImageEntry, Spec } from './spec';

/** What the quote step found, for the final summary. */
export interface QuoteRow {
  readonly id: string;
  readonly quoteId: string;
  readonly credits: string | null;
  readonly billingUnit: string | null;
  readonly model: unknown;
  readonly aspect: unknown;
  readonly expiresAt: unknown;
}

export interface SetupOutcome {
  quotes: QuoteRow[];
  totalCredits: string | null;
  totalAmount: string | null;
  billingUnit: string | null;
  balance: number | null;
  /** Jobs on the host channel: the host's own image tool generates them, there is nothing to quote. */
  hostJobs: string[];
}

export interface SetupContext {
  readonly rt: Runtime;
  readonly spec: Spec;
  /** `--dir` as typed. */
  readonly dir: string;
  /** Absolute directory of the spec file: the base of every relative path in it. */
  readonly specDir: string;
  readonly config?: string;
  readonly acceptUnknownCost: boolean;
  /** The project: loaded when it exists, set by the init step when it does not. */
  project: Project | null;
  readonly outcome: SetupOutcome;
}

/** A path from the spec, as an absolute path. */
export const fromSpec = (ctx: Pick<SetupContext, 'rt' | 'specDir'>, path: string): string => ctx.rt.path.resolve(ctx.specDir, path);

export const projectRoot = (ctx: Pick<SetupContext, 'rt' | 'dir'>): string => ctx.rt.path.resolve(ctx.rt.cwd, ctx.dir);

/** The picture a `ref` entry names when it is a path: next to the spec, else inside the project; `null` when it is nowhere. */
export const locateRef = async (ctx: Pick<SetupContext, 'rt' | 'dir' | 'specDir'>, path: string): Promise<string | null> => {
  const { rt } = ctx;
  const beside = fromSpec(ctx, path);
  if (await isFile(rt, beside)) return beside;
  const inside = rt.path.isAbsolute(path) ? null : rt.path.resolve(projectRoot(ctx), path);
  return inside !== null && (await isFile(rt, inside)) ? inside : null;
};

export const jobIdOf = (entry: ImageEntry): string => (entry.purpose === 'composition' ? 'composition' : entry.id);

/** The page ids the spec asks for; a page count means p1…pN. */
export const wantedPages = (spec: Spec): readonly string[] =>
  typeof spec.pages === 'number' ? Array.from({ length: spec.pages }, (_, index) => `p${index + 1}`) : (spec.pages ?? []);

export interface PagePlan {
  /** The pages the project has now (a project that is not created yet will start with p1). */
  readonly existing: readonly string[];
  readonly add: readonly string[];
  /** The page ids once the pages step is done. */
  readonly final: readonly string[];
}

export const pagePlan = (ctx: Pick<SetupContext, 'spec' | 'project'>): PagePlan => {
  const existing = ctx.project ? ctx.project.manifest.pages.map((page) => page.id) : ['p1'];
  const add = wantedPages(ctx.spec).filter((id) => !existing.includes(id));
  return { existing, add, final: [...existing, ...add] };
};

/** Size of the pages the setup adds: the spec's, else the project's first page, else what `init` defaults to. */
export const pageSize = (ctx: Pick<SetupContext, 'spec' | 'project'>): { width: number; height: number } => {
  const first = ctx.project?.manifest.pages[0];
  return { width: ctx.spec.width ?? first?.width ?? 1080, height: ctx.spec.height ?? first?.height ?? 1350 };
};
