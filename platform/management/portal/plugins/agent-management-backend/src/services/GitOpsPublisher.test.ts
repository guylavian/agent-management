// backstage-cli package test runs jest; describe/it/expect are global.
import { GitHubGitOpsPublisher } from './GitOpsPublisher';

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
