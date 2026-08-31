import type {
  CreateHostedReviewInput,
  CreateHostedReviewResult,
  CreateStackedHostedReviewInput,
  CreateStackedHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewCreationEligibilityArgs,
  HostedReviewInfo
} from '../../shared/hosted-review'
import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import type { PRRefreshOutcome } from '../../shared/github/pull-request-refresh-types'
import type { Repo } from '../../shared/repo-types'
import {
  getPRForBranchOutcome,
  getRepoSlug,
  getRepoUpstream,
  type GitHubPRBranchLookupOptions
} from '../github/client'
import { getHostedReviewForBranch } from '../source-control/hosted-review'
import {
  createHostedReview,
  getHostedReviewCreationEligibility
} from '../source-control/hosted-review-creation'
import type { HostedReviewExecutionOptions } from '../source-control/hosted-review-git-options'
import { createStackedHostedReview } from '../source-control/stacked-hosted-review-creation'

type HostedReviewTargetArgs = { repoSelector: string; worktreeSelector?: string }

type RuntimeHostedReviewCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  resolveTarget: (args: HostedReviewTargetArgs) => Promise<{ repo: Repo; repoPath: string }>
  getExecutionOptions: (repo: Repo) => HostedReviewExecutionOptions | undefined
  recordCreated: (repoId: string, number: number, url: string) => void
}

export class RuntimeHostedReviewCommands {
  constructor(private readonly deps: RuntimeHostedReviewCommandsDeps) {}

  async getRepoSlug(repoSelector: string): Promise<GitHubOwnerRepo | null> {
    const repo = await this.deps.resolveRepo(repoSelector)
    const options = this.deps.getExecutionOptions(repo)
    return options
      ? getRepoSlug(repo.path, repo.connectionId ?? null, options)
      : getRepoSlug(repo.path, repo.connectionId ?? null)
  }

  async getRepoUpstream(repoSelector: string): Promise<GitHubOwnerRepo | null> {
    const repo = await this.deps.resolveRepo(repoSelector)
    const options = this.deps.getExecutionOptions(repo)
    return options
      ? getRepoUpstream(repo.path, repo.connectionId ?? null, options)
      : getRepoUpstream(repo.path, repo.connectionId ?? null)
  }

  async getRepoPRForBranch(
    repoSelector: string,
    branch: string,
    linkedPRNumber?: number | null,
    fallbackPRNumber?: number | null,
    acceptMergedFallbackPR?: boolean,
    currentHeadOid?: string | null
  ): Promise<PRRefreshOutcome> {
    const repo = await this.deps.resolveRepo(repoSelector)
    const lookupOptions: GitHubPRBranchLookupOptions = {
      ...this.deps.getExecutionOptions(repo)
    }
    if (acceptMergedFallbackPR === true) {
      lookupOptions.acceptMergedFallbackPR = true
    }
    if (typeof currentHeadOid === 'string' && currentHeadOid.trim().length > 0) {
      lookupOptions.currentHeadOid = currentHeadOid.trim()
    }
    const lookupOptionArgs: [] | [GitHubPRBranchLookupOptions] =
      Object.keys(lookupOptions).length > 0 ? [lookupOptions] : []
    return getPRForBranchOutcome(
      repo.path,
      branch,
      linkedPRNumber ?? null,
      repo.connectionId ?? null,
      linkedPRNumber == null ? (fallbackPRNumber ?? null) : null,
      ...lookupOptionArgs
    )
  }

  async getHostedReviewForBranch(args: {
    repoSelector: string
    branch: string
    currentHeadOid?: string | null
    active?: boolean
    linkedGitHubPR?: number | null
    fallbackGitHubPR?: number | null
    linkedGitLabMR?: number | null
    linkedBitbucketPR?: number | null
    linkedAzureDevOpsPR?: number | null
    linkedGiteaPR?: number | null
  }): Promise<HostedReviewInfo | null> {
    const repo = await this.deps.resolveRepo(args.repoSelector)
    const review = await getHostedReviewForBranch({
      repoPath: repo.path,
      connectionId: repo.connectionId ?? null,
      branch: args.branch,
      currentHeadOid: args.currentHeadOid ?? null,
      ...(args.active === true ? { active: true } : {}),
      linkedGitHubPR: args.linkedGitHubPR ?? null,
      fallbackGitHubPR: args.linkedGitHubPR == null ? (args.fallbackGitHubPR ?? null) : null,
      linkedGitLabMR: args.linkedGitLabMR ?? null,
      linkedBitbucketPR: args.linkedBitbucketPR ?? null,
      linkedAzureDevOpsPR: args.linkedAzureDevOpsPR ?? null,
      linkedGiteaPR: args.linkedGiteaPR ?? null,
      ...this.deps.getExecutionOptions(repo)
    })
    if (review?.provider === 'github') {
      this.deps.recordCreated(repo.id, review.number, review.url)
    }
    return review
  }

  async getHostedReviewCreationEligibility(
    args: Omit<HostedReviewCreationEligibilityArgs, 'repoPath'> & HostedReviewTargetArgs
  ): Promise<HostedReviewCreationEligibility> {
    const { repo, repoPath } = await this.deps.resolveTarget(args)
    return getHostedReviewCreationEligibility({
      repoPath,
      connectionId: repo.connectionId ?? null,
      branch: args.branch,
      base: args.base ?? null,
      hasUncommittedChanges: args.hasUncommittedChanges,
      hasUpstream: args.hasUpstream,
      ahead: args.ahead,
      behind: args.behind,
      linkedGitHubPR: args.linkedGitHubPR ?? null,
      fallbackGitHubPR: args.linkedGitHubPR == null ? (args.fallbackGitHubPR ?? null) : null,
      linkedGitLabMR: args.linkedGitLabMR ?? null,
      linkedBitbucketPR: args.linkedBitbucketPR ?? null,
      linkedAzureDevOpsPR: args.linkedAzureDevOpsPR ?? null,
      linkedGiteaPR: args.linkedGiteaPR ?? null,
      ...this.deps.getExecutionOptions(repo)
    })
  }

  async createHostedReview(
    args: CreateHostedReviewInput & HostedReviewTargetArgs
  ): Promise<CreateHostedReviewResult> {
    const { repo, repoPath } = await this.deps.resolveTarget(args)
    const input = {
      provider: args.provider,
      base: args.base,
      head: args.head,
      title: args.title,
      body: args.body,
      draft: args.draft,
      ...(args.useTemplate !== undefined ? { useTemplate: args.useTemplate } : {})
    }
    const options = this.deps.getExecutionOptions(repo)
    const result = options
      ? await createHostedReview(repoPath, input, repo.connectionId ?? null, options)
      : await createHostedReview(repoPath, input, repo.connectionId ?? null)
    if (result.ok) {
      this.deps.recordCreated(repo.id, result.number, result.url)
    }
    return result
  }

  async createStackedHostedReview(
    args: CreateStackedHostedReviewInput & HostedReviewTargetArgs
  ): Promise<CreateStackedHostedReviewResult> {
    const { repo, repoPath } = await this.deps.resolveTarget(args)
    const result = await createStackedHostedReview(
      repoPath,
      {
        provider: args.provider,
        base: args.base,
        head: args.head,
        title: args.title,
        body: args.body,
        draft: args.draft,
        ...(args.useTemplate !== undefined ? { useTemplate: args.useTemplate } : {})
      },
      repo.connectionId ?? null,
      this.deps.getExecutionOptions(repo) ?? {}
    )
    if (result.ok) {
      this.deps.recordCreated(repo.id, result.number, result.url)
    }
    return result
  }
}
