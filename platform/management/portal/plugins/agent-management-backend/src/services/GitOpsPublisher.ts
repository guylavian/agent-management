import { createServiceFactory, createServiceRef, coreServices, type RootConfigService } from '@backstage/backend-plugin-api';
import { ScmIntegrations } from '@backstage/integration';
import { Octokit } from '@octokit/rest';

/**
 * Opens the pull request that changes an Agent.
 *
 * This lives in the MANAGEMENT plane, not the runtime. Before, the portal asked
 * the runtime to open the PR, which meant the execution plane held a Git write
 * token — a credential the request path has no use for, on the one process that
 * must not be able to change its own policy.
 *
 *   portal → Backstage backend → Git provider → pull request
 *
 * The runtime still owns the canonical Agent SCHEMA and renders the change-set,
 * because it is the thing that must load the result at startup. It just no
 * longer performs the write. Its `/management/agents/preview` is pure.
 *
 * Credentials come from Backstage's own SCM integrations, so the token is
 * configured once, in the place Backstage already expects it, and never appears
 * in this plugin's config.
 */

export interface ChangedFile {
  path: string;
  contents: string;
  /**
   * `base64` when `contents` carries bytes rather than text.
   *
   * Without this the encode below treats an image as UTF-8 and commits a
   * corrupted file that still looks like a successful pull request. An avatar
   * is the first binary file this platform writes, so the encoding travels with
   * the file rather than being guessed from its extension.
   */
  encoding?: 'base64';
}

export interface PullRequestInput {
  branch: string;
  title: string;
  body: string;
  files: ChangedFile[];
}

export interface PullRequestOutcome {
  status: 'created' | 'not-configured';
  url?: string;
  number?: number;
  reason?: string;
}

export interface GitOpsPublisher {
  readonly configured: boolean;
  createPullRequest(input: PullRequestInput): Promise<PullRequestOutcome>;
}

export interface GitHubGitOpsSettings {
  owner: string;
  repo: string;
  baseBranch: string;
  token: string;
  apiBaseUrl?: string;
}

/**
 * Reports "not configured" rather than pretending. A portal that shows a
 * success state for a pull request that does not exist is worse than one that
 * says it cannot open one.
 */
export class UnconfiguredGitOpsPublisher implements GitOpsPublisher {
  readonly configured = false;
  readonly #reason: string;
  constructor(reason: string) {
    this.#reason = reason;
  }
  async createPullRequest(): Promise<PullRequestOutcome> {
    return { status: 'not-configured', reason: this.#reason };
  }
}

export class GitHubGitOpsPublisher implements GitOpsPublisher {
  readonly configured = true;
  readonly #settings: GitHubGitOpsSettings;
  readonly #octokit: Octokit;

  constructor(settings: GitHubGitOpsSettings, octokit?: Octokit) {
    this.#settings = settings;
    this.#octokit =
      octokit ??
      new Octokit({ auth: settings.token, ...(settings.apiBaseUrl ? { baseUrl: settings.apiBaseUrl } : {}) });
  }

  async createPullRequest(input: PullRequestInput): Promise<PullRequestOutcome> {
    const { owner, repo, baseBranch } = this.#settings;

    const base = await this.#octokit.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
    // a branch, never a push to the default branch: the change is reviewed or it
    // does not happen
    await this.#octokit.git
      .createRef({ owner, repo, ref: `refs/heads/${input.branch}`, sha: base.data.object.sha })
      .catch((error: { status?: number }) => {
        // 422 means the branch already exists — an amended proposal, not a failure
        if (error.status !== 422) throw error;
      });

    for (const file of input.files) {
      const existing = await this.#octokit.repos
        .getContent({ owner, repo, path: file.path, ref: input.branch })
        .catch(() => undefined);
      const sha = existing && !Array.isArray(existing.data) && 'sha' in existing.data ? existing.data.sha : undefined;
      await this.#octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: file.path,
        message: `${input.title} (${file.path})`,
        content: file.encoding === 'base64' ? file.contents : Buffer.from(file.contents, 'utf8').toString('base64'),
        branch: input.branch,
        ...(sha ? { sha } : {}),
      });
    }

    // The branch name is derived from the agent, so proposing a second change to
    // the same agent reuses it. createRef already treats that as an amendment;
    // pulls.create has to agree, or the amendment fails at the last step with the
    // provider's 422 ("a pull request already exists") reaching the browser.
    // The files were just written to the branch, so the open PR already shows
    // the new change — returning it is the truthful answer, not a consolation.
    const pull = await this.#octokit.pulls
      .create({ owner, repo, title: input.title, head: input.branch, base: baseBranch, body: input.body })
      .catch(async (error: { status?: number }) => {
        if (error.status !== 422) throw error;
        const open = await this.#octokit.pulls.list({ owner, repo, head: `${owner}:${input.branch}`, state: 'open' });
        const existing = open.data[0];
        // 422 also covers "no commits between" — a draft identical to the base.
        // There is no pull request to point at, so that stays an error.
        if (existing === undefined) throw error;
        return { data: { html_url: existing.html_url, number: existing.number } };
      });
    return { status: 'created', url: pull.data.html_url, number: pull.data.number };
  }
}

export const gitOpsPublisherRef = createServiceRef<GitOpsPublisher>({
  id: 'sre.agent-management.gitops',
  defaultFactory: async service =>
    createServiceFactory({
      service,
      deps: { config: coreServices.rootConfig },
      async factory({ config }: { config: RootConfigService }) {
        return fromConfig(config);
      },
    }),
});

export function fromConfig(config: RootConfigService): GitOpsPublisher {
  const gitops = config.getOptionalConfig('sreAgent.gitops');
  const owner = gitops?.getOptionalString('owner');
  const repo = gitops?.getOptionalString('repo');
  if (!owner || !repo) {
    return new UnconfiguredGitOpsPublisher('sreAgent.gitops.owner and sreAgent.gitops.repo are not set');
  }

  const host = gitops?.getOptionalString('host') ?? 'github.com';
  const integrations = ScmIntegrations.fromConfig(config);
  const integration = integrations.github.byHost(host);
  // the token is Backstage's SCM integration credential, configured once where
  // Backstage already expects it, rather than a second secret in this plugin
  const token = integration?.config.token;
  if (!token) {
    return new UnconfiguredGitOpsPublisher(`no GitHub integration token is configured for ${host}`);
  }

  return new GitHubGitOpsPublisher({
    owner,
    repo,
    baseBranch: gitops?.getOptionalString('baseBranch') ?? 'main',
    token,
    ...(integration?.config.apiBaseUrl ? { apiBaseUrl: integration.config.apiBaseUrl } : {}),
  });
}
