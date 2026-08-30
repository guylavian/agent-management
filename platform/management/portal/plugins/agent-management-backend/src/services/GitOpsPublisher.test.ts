// backstage-cli package test runs jest; describe/it/expect are global.
import { BitbucketServerGitOpsPublisher, GitHubGitOpsPublisher, UnconfiguredGitOpsPublisher, proposalFromBranch } from './GitOpsPublisher';

/**
 * Amending a proposal is the normal case, not the exceptional one: the branch
 * name is derived from the agent, so the second edit to an agent always lands on
 * a branch that already has an open pull request.
 */
function octokitDouble(overrides: {
  createRef?: unknown;
  pullsCreate?: unknown;
  pullsList?: unknown;
}) {
  const reject = (status: number) => () => Promise.reject(Object.assign(new Error(`http ${status}`), { status }));
  return {
    git: {
      getRef: jest.fn().mockResolvedValue({ data: { object: { sha: 'basesha' } } }),
      createRef: overrides.createRef ?? jest.fn().mockResolvedValue({}),
    },
    repos: {
      getContent: jest.fn().mockRejectedValue(new Error('not found')),
      createOrUpdateFileContents: jest.fn().mockResolvedValue({}),
    },
    pulls: {
      create: overrides.pullsCreate ?? jest.fn().mockResolvedValue({ data: { html_url: 'http://pr/9', number: 9 } }),
      list: overrides.pullsList ?? jest.fn().mockResolvedValue({ data: [] }),
      _reject: reject,
    },
  } as never;
}

const settings = { owner: 'o', repo: 'r', baseBranch: 'main', token: 't' };
const input = { branch: 'agent/update-keycloak', title: 'Update keycloak', body: 'b', files: [{ path: 'a.yaml', contents: 'x' }] };

describe('GitHubGitOpsPublisher', () => {
  it('opens a pull request for a new proposal', async () => {
    const publisher = new GitHubGitOpsPublisher(settings, octokitDouble({}));
    await expect(publisher.createPullRequest(input)).resolves.toMatchObject({ status: 'created', number: 9 });
  });

  it('returns the open pull request when one already exists for the branch', async () => {
    // GitHub answers 422 to both createRef and pulls.create on an amendment.
    const conflict = () => Promise.reject(Object.assign(new Error('exists'), { status: 422 }));
    const publisher = new GitHubGitOpsPublisher(
      settings,
      octokitDouble({
        createRef: jest.fn(conflict),
        pullsCreate: jest.fn(conflict),
        pullsList: jest.fn().mockResolvedValue({ data: [{ html_url: 'http://pr/2', number: 2 }] }),
      }),
    );

    await expect(publisher.createPullRequest(input)).resolves.toMatchObject({
      status: 'created',
      url: 'http://pr/2',
      number: 2,
    });
  });

  it('still fails when 422 means there is nothing to propose', async () => {
    // "No commits between main and <branch>" is also a 422, and there is no
    // pull request to point at. Reporting success would be a lie.
    const publisher = new GitHubGitOpsPublisher(
      settings,
      octokitDouble({
        pullsCreate: jest.fn(() => Promise.reject(Object.assign(new Error('no commits'), { status: 422 }))),
        pullsList: jest.fn().mockResolvedValue({ data: [] }),
      }),
    );

    await expect(publisher.createPullRequest(input)).rejects.toThrow();
  });

  it('does not swallow a non-422 failure', async () => {
    const publisher = new GitHubGitOpsPublisher(
      settings,
      octokitDouble({
        pullsCreate: jest.fn(() => Promise.reject(Object.assign(new Error('boom'), { status: 500 }))),
      }),
    );

    await expect(publisher.createPullRequest(input)).rejects.toThrow();
  });
});

/**
 * The Bitbucket Server publisher speaks /rest/api/1.0 directly, so its double is
 * a fetch. Same behavioural contract as GitHub, different provider grammar:
 * 409 where GitHub answers 422, and the duplicate-PR error carries the existing
 * pull request in its payload instead of needing a list call.
 */
function bitbucketFetch(overrides: { branch?: number; commit?: number; pull?: () => Response } = {}) {
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const calls: Array<{ method: string; url: string }> = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    calls.push({ method: init?.method ?? 'GET', url: href });
    if (href.includes('/branches')) return json(overrides.branch ?? 200, {});
    if (href.includes('/commits?')) return json(overrides.commit ?? 404, {});
    if (href.includes('/browse/')) return json(200, {});
    if (href.includes('/pull-requests')) {
      return overrides.pull
        ? overrides.pull()
        : json(201, { id: 7, links: { self: [{ href: 'http://bb/pr/7' }] } });
    }
    return json(404, {});
  };
  return { impl: impl as typeof fetch, calls, json };
}

const bbSettings = { projectKey: 'SRE', repo: 'agents', baseBranch: 'main', token: 't', apiBaseUrl: 'http://bb/rest/api/1.0' };

describe('BitbucketServerGitOpsPublisher', () => {
  it('opens a pull request for a new proposal', async () => {
    const double = bitbucketFetch();
    const publisher = new BitbucketServerGitOpsPublisher(bbSettings, double.impl);
    await expect(publisher.createPullRequest(input)).resolves.toMatchObject({
      status: 'created',
      number: 7,
      url: 'http://bb/pr/7',
    });
    // branch first, then the file, then the PR — and everything under the repo path
    expect(double.calls.map(c => c.method)).toEqual(['POST', 'GET', 'PUT', 'POST']);
    expect(double.calls.every(c => c.url.startsWith('http://bb/rest/api/1.0/projects/SRE/repos/agents'))).toBe(true);
  });

  it('treats an existing branch as an amendment, not a failure', async () => {
    const double = bitbucketFetch({ branch: 409 });
    const publisher = new BitbucketServerGitOpsPublisher(bbSettings, double.impl);
    await expect(publisher.createPullRequest(input)).resolves.toMatchObject({ status: 'created' });
  });

  it('returns the open pull request the duplicate error carries', async () => {
    const double = bitbucketFetch({
      pull: () =>
        new Response(
          JSON.stringify({ errors: [{ existingPullRequest: { id: 3, links: { self: [{ href: 'http://bb/pr/3' }] } } }] }),
          { status: 409 },
        ),
    });
    const publisher = new BitbucketServerGitOpsPublisher(bbSettings, double.impl);
    await expect(publisher.createPullRequest(input)).resolves.toMatchObject({
      status: 'created',
      number: 3,
      url: 'http://bb/pr/3',
    });
  });

  it('still fails when 409 means there is nothing to propose', async () => {
    // "already up to date" is also a 409, with no existing PR in the payload.
    // Reporting success would be a lie.
    const double = bitbucketFetch({
      pull: () => new Response(JSON.stringify({ errors: [{ message: 'already up to date' }] }), { status: 409 }),
    });
    const publisher = new BitbucketServerGitOpsPublisher(bbSettings, double.impl);
    await expect(publisher.createPullRequest(input)).rejects.toThrow(/already up to date/);
  });

  it('does not swallow a non-409 failure', async () => {
    const double = bitbucketFetch({ pull: () => new Response('boom', { status: 500 }) });
    const publisher = new BitbucketServerGitOpsPublisher(bbSettings, double.impl);
    await expect(publisher.createPullRequest(input)).rejects.toThrow(/failed \(500\)/);
  });
});

/**
 * PENDING MERGE, observed rather than remembered.
 *
 * The runtime reads the repository as Argo synced it, so an Agent whose pull
 * request is still open does not exist to it. Only this plane holds the Git
 * credential, so only this plane can see one — and before it did, "Pending
 * merge" was a badge that lived on the page which had just created the
 * proposal and vanished the moment the operator navigated away.
 */
describe('proposalFromBranch', () => {
  it('recovers the agent id from the branch the runtime derived it into', () => {
    expect(proposalFromBranch('agent/add-kafka', 'Add kafka')).toMatchObject({ agentId: 'kafka', kind: 'add' });
    expect(proposalFromBranch('agent/update-kafka', 'Update kafka')).toMatchObject({ agentId: 'kafka', kind: 'update' });
  });

  it('ignores branches that are not an Agent waiting to appear', () => {
    // a prompt edit and a Manager edit both change something that ALREADY
    // exists; listing either as pending-merge would invent a second row for an
    // agent that is on the page already
    expect(proposalFromBranch('agent/kafka-prompt', 'Prompt')).toBeUndefined();
    expect(proposalFromBranch('agent/update-manager', 'Manager')).toBeUndefined();
    expect(proposalFromBranch('feature/unrelated', 'Something else')).toBeUndefined();
    // and never trusts the branch to be a legal agent name
    expect(proposalFromBranch('agent/add-../../etc/passwd', 'Nope')).toBeUndefined();
    expect(proposalFromBranch('agent/add-Kafka', 'Nope')).toBeUndefined();
  });
});

describe('listing open proposals', () => {
  it('reads them from GitHub without a second credential', async () => {
    const octokit = octokitDouble({
      pullsList: jest.fn().mockResolvedValue({
        data: [
          { head: { ref: 'agent/add-kafka' }, title: 'Add kafka', html_url: 'http://pr/1', number: 1 },
          { head: { ref: 'chore/bump' }, title: 'Bump', html_url: 'http://pr/2', number: 2 },
        ],
      }),
    });
    const publisher = new GitHubGitOpsPublisher(settings, octokit);
    await expect(publisher.listProposals()).resolves.toEqual([
      { agentId: 'kafka', kind: 'add', branch: 'agent/add-kafka', title: 'Add kafka', url: 'http://pr/1', number: 1 },
    ]);
  });

  it('reads them from Bitbucket Data Center with its own grammar', async () => {
    // `fromRef.displayId` and `/rest/api/1.0`, not the Cloud 2.0 shape: the
    // provider abstraction has to stay usable on Data Center
    const calls: string[] = [];
    const publisher = new BitbucketServerGitOpsPublisher(
      { projectKey: 'SRE', repo: 'platform', baseBranch: 'main', token: 't', apiBaseUrl: 'https://bb/rest/api/1.0' },
      (async (url: string) => {
        calls.push(String(url));
        return new Response(
          JSON.stringify({
            values: [
              { id: 7, title: 'Add kafka', fromRef: { displayId: 'agent/add-kafka' }, links: { self: [{ href: 'https://bb/pr/7' }] } },
              { id: 8, title: 'Release', fromRef: { displayId: 'release/1.2' } },
            ],
          }),
          { status: 200 },
        );
      }) as never,
    );
    await expect(publisher.listProposals()).resolves.toEqual([
      { agentId: 'kafka', kind: 'add', branch: 'agent/add-kafka', title: 'Add kafka', url: 'https://bb/pr/7', number: 7 },
    ]);
    expect(calls[0]).toContain('/projects/SRE/repos/platform/pull-requests?state=OPEN');
  });

  it('answers with an empty list, not an error, when no Git credential is configured', async () => {
    // the page-level message says proposals were not observed; a throw here
    // would take the whole Agents view down over a feature that only adds rows
    await expect(new UnconfiguredGitOpsPublisher('no token').listProposals()).resolves.toEqual([]);
  });
});
