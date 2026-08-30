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

/**
 * An Agent that has been PROPOSED but not merged.
 *
 * Only the management plane can see one. The runtime reads the repository as
 * Argo synced it, so an open branch does not exist to it at all — which is why
 * "Pending merge" could previously only be a badge on the page that had just
 * opened the pull request, and vanished the moment the operator navigated away.
 *
 * The agent id is recovered from the BRANCH, which the runtime derives from the
 * agent name (`agent/add-<name>`). That is the only part of a proposal this
 * plane may read: opening the diff to parse the YAML would put the canonical
 * Agent schema in the management plane, which is the boundary the whole design
 * keeps.
 */
export interface AgentProposal {
  agentId: string;
  /** "add" or "update" — an update is a change to an Agent that already exists */
  kind: 'add' | 'update';
  branch: string;
  title: string;
  url?: string;
  number?: number;
}

export interface GitOpsPublisher {
  readonly configured: boolean;
  createPullRequest(input: PullRequestInput): Promise<PullRequestOutcome>;
  /**
   * Open Agent proposals, or an empty list when this deployment has no Git
   * credential. Empty is honest here: with no credential nothing was observed,
   * and the console says so at the page level rather than per row.
   */
  listProposals(): Promise<AgentProposal[]>;
}

/** `agent/add-kafka` → kafka. Anything else on the branch list is not ours. */
export function proposalFromBranch(branch: string, title: string, extra: { url?: string; number?: number } = {}): AgentProposal | undefined {
  const match = /^agent\/(add|update)-(?<name>[a-z][a-z0-9-]*)$/u.exec(branch);
  const name = match?.groups?.name;
  // `agent/update-manager` and `agent/<name>-prompt` are changes to something
  // that already exists; neither is an Agent waiting to appear
  if (name === undefined || name === 'manager') return undefined;
  return { agentId: name, kind: match?.[1] === 'update' ? 'update' : 'add', branch, title, ...extra };
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
  async listProposals(): Promise<AgentProposal[]> {
    return [];
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

  async listProposals(): Promise<AgentProposal[]> {
    const { owner, repo } = this.#settings;
    const open = await this.#octokit.pulls.list({ owner, repo, state: 'open', per_page: 100 });
    return open.data
      .map(pull => proposalFromBranch(pull.head.ref, pull.title, { url: pull.html_url, number: pull.number }))
      .filter((proposal): proposal is AgentProposal => proposal !== undefined);
  }
}

export interface BitbucketServerGitOpsSettings {
  /** Bitbucket Server project KEY (the `owner` config key, reused across providers) */
  projectKey: string;
  /** repository slug */
  repo: string;
  baseBranch: string;
  token: string;
  /** e.g. https://bitbucket.company.com/rest/api/1.0 — from the SCM integration */
  apiBaseUrl: string;
}

/**
 * Bitbucket Server / Data Center. Same contract, different provider grammar:
 * project key + repository slug instead of owner/repo, `/rest/api/1.0` instead
 * of the Cloud 2.0 API (which is why the Cloud-oriented `bitbucket` npm client
 * is not used here), and a 409 where GitHub answers 422.
 *
 * The amendment path is deliberately identical in behaviour to the GitHub
 * publisher: the branch name derives from the agent, so the second proposal for
 * an agent lands on an existing branch with an open pull request — that is the
 * normal case, and the open PR (which now shows the new files) is the truthful
 * answer.
 */
export class BitbucketServerGitOpsPublisher implements GitOpsPublisher {
  readonly configured = true;
  readonly #settings: BitbucketServerGitOpsSettings;
  readonly #fetch: typeof fetch;

  constructor(settings: BitbucketServerGitOpsSettings, fetchImplementation: typeof fetch = fetch) {
    this.#settings = settings;
    this.#fetch = fetchImplementation;
  }

  get #repoUrl(): string {
    const { apiBaseUrl, projectKey, repo } = this.#settings;
    return `${apiBaseUrl.replace(/\/$/u, '')}/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repo)}`;
  }

  async #call(method: string, path: string, body?: BodyInit, contentType?: string): Promise<Response> {
    return this.#fetch(`${this.#repoUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#settings.token}`,
        // multipart bodies must set their own boundary header; JSON declares itself
        ...(contentType ? { 'content-type': contentType } : {}),
      },
      ...(body !== undefined ? { body } : {}),
    });
  }

  async createPullRequest(input: PullRequestInput): Promise<PullRequestOutcome> {
    const { baseBranch } = this.#settings;

    // a branch, never a push to the default branch: the change is reviewed or it
    // does not happen. 409 means the branch already exists — an amendment.
    const created = await this.#call('POST', '/branches', JSON.stringify({ name: input.branch, startPoint: `refs/heads/${baseBranch}` }), 'application/json');
    if (!created.ok && created.status !== 409) throw this.#asError(created.status, await created.text().catch(() => ''), 'create branch');

    for (const file of input.files) {
      // Bitbucket requires the file's latest commit id when EDITING, and its
      // absence when creating — so ask which case this is first.
      const history = await this.#call('GET', `/commits?path=${encodeURIComponent(file.path)}&until=${encodeURIComponent(`refs/heads/${input.branch}`)}&limit=1`);
      const latest = history.ok ? ((await history.json()) as { values?: Array<{ id: string }> }).values?.[0]?.id : undefined;

      const form = new FormData();
      form.set('branch', input.branch);
      form.set('message', `${input.title} (${file.path})`);
      form.set('content', new Blob([file.encoding === 'base64' ? Buffer.from(file.contents, 'base64') : Buffer.from(file.contents, 'utf8')]), file.path.split('/').pop() ?? file.path);
      if (latest) form.set('sourceCommitId', latest);
      const put = await this.#call('PUT', `/browse/${file.path.split('/').map(encodeURIComponent).join('/')}`, form);
      // an unchanged file answers 409 ("could not be committed"); for an
      // amendment that resubmits identical content that is not a failure
      if (!put.ok && put.status !== 409) throw this.#asError(put.status, await put.text().catch(() => ''), `commit ${file.path}`);
    }

    const ref = (branch: string) => ({ id: `refs/heads/${branch}`, repository: { slug: this.#settings.repo, project: { key: this.#settings.projectKey } } });
    const pull = await this.#call('POST', '/pull-requests', JSON.stringify({ title: input.title, description: input.body, fromRef: ref(input.branch), toRef: ref(baseBranch) }), 'application/json');
    if (pull.ok) {
      const data = (await pull.json()) as { id: number; links?: { self?: Array<{ href: string }> } };
      return { status: 'created', number: data.id, ...(data.links?.self?.[0]?.href ? { url: data.links.self[0].href } : {}) };
    }

    // a body reads once; the 409 handling below needs it parsed AND #asError
    // needs its message, so it is captured here rather than re-read
    const body = await pull.text().catch(() => '');

    // a duplicate answers 409 and — unlike GitHub — hands back the existing PR
    // inside the error payload, so no second lookup is needed
    if (pull.status === 409) {
      const payload = (() => {
        try {
          return JSON.parse(body) as { errors?: Array<{ existingPullRequest?: { id: number; links?: { self?: Array<{ href: string }> } } }> };
        } catch {
          return {};
        }
      })() as { errors?: Array<{ existingPullRequest?: { id: number; links?: { self?: Array<{ href: string }> } } }> };
      const existing = payload.errors?.find(error => error.existingPullRequest)?.existingPullRequest;
      // 409 also covers "already up to date" — a proposal identical to the base.
      // There is no pull request to point at, so that stays an error.
      if (existing) return { status: 'created', number: existing.id, ...(existing.links?.self?.[0]?.href ? { url: existing.links.self[0].href } : {}) };
    }
    throw this.#asError(pull.status, body, 'create pull request');
  }

  async listProposals(): Promise<AgentProposal[]> {
    // Data Center's own pagination and state filter; `fromRef.displayId` is the
    // branch short name, which is what the runtime derived the id from
    const response = await this.#call('GET', '/pull-requests?state=OPEN&limit=100');
    if (!response.ok) throw this.#asError(response.status, await response.text().catch(() => ''), 'list pull requests');
    const body = (await response.json()) as {
      values?: Array<{ id: number; title: string; fromRef?: { displayId?: string }; links?: { self?: Array<{ href: string }> } }>;
    };
    return (body.values ?? [])
      .map(pull => proposalFromBranch(pull.fromRef?.displayId ?? '', pull.title, {
        number: pull.id,
        ...(pull.links?.self?.[0]?.href ? { url: pull.links.self[0].href } : {}),
      }))
      .filter((proposal): proposal is AgentProposal => proposal !== undefined);
  }

  #asError(status: number, body: string, action: string): Error {
    const message = (() => {
      try {
        return (JSON.parse(body) as { errors?: Array<{ message?: string }> }).errors?.[0]?.message;
      } catch {
        return undefined;
      }
    })();
    return Object.assign(new Error(`bitbucket ${action} failed (${status})${message ? `: ${message}` : ''}`), { status });
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

  const provider = gitops?.getOptionalString('provider') ?? 'github';
  const baseBranch = gitops?.getOptionalString('baseBranch') ?? 'main';
  const integrations = ScmIntegrations.fromConfig(config);

  if (provider === 'bitbucketServer') {
    // no default host: unlike github.com there is no canonical Bitbucket
    // Server, so guessing one would only defer the failure to the first request
    const host = gitops?.getOptionalString('host');
    if (!host) {
      return new UnconfiguredGitOpsPublisher('sreAgent.gitops.host is required for the bitbucketServer provider');
    }
    const integration = integrations.bitbucketServer.byHost(host);
    // the token is Backstage's SCM integration credential, configured once where
    // Backstage already expects it, rather than a second secret in this plugin
    const token = integration?.config.token;
    if (!token) {
      return new UnconfiguredGitOpsPublisher(`no Bitbucket Server integration token is configured for ${host}`);
    }
    return new BitbucketServerGitOpsPublisher({
      // `owner` is the Bitbucket PROJECT KEY; the config key is shared across
      // providers so switching provider does not mean renaming settings
      projectKey: owner,
      repo,
      baseBranch,
      token,
      apiBaseUrl: integration.config.apiBaseUrl,
    });
  }

  if (provider !== 'github') {
    return new UnconfiguredGitOpsPublisher(`unknown sreAgent.gitops.provider "${provider}" (github | bitbucketServer)`);
  }

  const host = gitops?.getOptionalString('host') ?? 'github.com';
  const integration = integrations.github.byHost(host);
  const token = integration?.config.token;
  if (!token) {
    return new UnconfiguredGitOpsPublisher(`no GitHub integration token is configured for ${host}`);
  }

  return new GitHubGitOpsPublisher({
    owner,
    repo,
    baseBranch,
    token,
    ...(integration?.config.apiBaseUrl ? { apiBaseUrl: integration.config.apiBaseUrl } : {}),
  });
}
