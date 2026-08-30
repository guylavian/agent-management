// backstage-cli package test runs jest; describe/it/expect are global.
import { BitbucketServerGitOpsPublisher, GitHubGitOpsPublisher } from './GitOpsPublisher';

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
