import type {
  ProjectRelease,
  ProjectReleasesPayload
} from "@pum/shared";

const defaultTtlMs = 30 * 60_000;
const maxBodyLength = 4000;

interface GitHubRepository {
  owner: string;
  repo: string;
  url: string;
}

export type RawProjectRelease = Omit<
  ProjectRelease,
  "isNewerThanCurrent"
>;

interface CachedReleaseNotes {
  value: ReleaseNotesResult;
  expiresAt: number;
}

export interface ReleaseNotesResult {
  repository: string;
  source: ProjectReleasesPayload["source"];
  releases: RawProjectRelease[];
  fetchedAt: string;
  stale?: boolean;
  error?: string;
}

interface ReleaseNotesOptions {
  token?: string;
  fetcher?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
}

export class ReleaseNotesService {
  private readonly cache = new Map<string, CachedReleaseNotes>();
  private readonly inFlight = new Map<string, Promise<ReleaseNotesResult>>();
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: ReleaseNotesOptions = {}) {
    this.token = options.token ?? "";
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? defaultTtlMs;
  }

  async get(repository: string): Promise<ReleaseNotesResult> {
    const parsed = parseGitHubRepository(repository);
    if (!parsed) {
      return {
        repository,
        source: "none",
        releases: [],
        fetchedAt: new Date(this.now()).toISOString()
      };
    }

    const cached = this.cache.get(parsed.url);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const activeRequest = this.inFlight.get(parsed.url);
    if (activeRequest) return activeRequest;

    const request = this.fetchAndCache(parsed, cached);
    this.inFlight.set(parsed.url, request);
    try {
      return await request;
    } finally {
      this.inFlight.delete(parsed.url);
    }
  }

  private async fetchAndCache(
    repository: GitHubRepository,
    cached: CachedReleaseNotes | undefined
  ): Promise<ReleaseNotesResult> {
    try {
      const releases = await this.fetchReleases(repository);
      const value: ReleaseNotesResult = {
        repository: repository.url,
        source: "github",
        releases,
        fetchedAt: new Date(this.now()).toISOString()
      };
      this.cache.set(repository.url, {
        value,
        expiresAt: this.now() + this.ttlMs
      });
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cached) {
        return { ...cached.value, stale: true, error: message };
      }
      return {
        repository: repository.url,
        source: "github",
        releases: [],
        fetchedAt: new Date(this.now()).toISOString(),
        error: message
      };
    }
  }

  private async fetchReleases(
    repository: GitHubRepository
  ): Promise<RawProjectRelease[]> {
    const baseUrl = `https://api.github.com/repos/${repository.owner}/${repository.repo}`;
    const response = await this.request(`${baseUrl}/releases?per_page=15`);
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) throw new Error("GitHub releases response is invalid");

    const releases = payload
      .filter(isPublishedRelease)
      .sort((left, right) =>
        String(right.published_at).localeCompare(String(left.published_at))
      )
      .map((release) => ({
        tagName: stringValue(release.tag_name),
        name: stringValue(release.name) || stringValue(release.tag_name),
        publishedAt: nullableString(release.published_at),
        htmlUrl: stringValue(release.html_url),
        body: stringValue(release.body).slice(0, maxBodyLength)
      }));
    if (releases.length) return releases;

    const tagsResponse = await this.request(`${baseUrl}/tags?per_page=10`);
    const tags = (await tagsResponse.json()) as unknown;
    if (!Array.isArray(tags)) throw new Error("GitHub tags response is invalid");
    return tags
      .map((tag) => {
        if (!tag || typeof tag !== "object") return null;
        const tagName = stringValue((tag as Record<string, unknown>).name);
        if (!tagName) return null;
        return {
          tagName,
          name: tagName,
          publishedAt: null,
          htmlUrl: `${repository.url}/releases/tag/${encodeURIComponent(tagName)}`,
          body: ""
        };
      })
      .filter((tag): tag is NonNullable<typeof tag> => tag !== null);
  }

  private request(url: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "Project-Update-Management"
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return this.fetcher(url, {
      headers,
      signal: AbortSignal.timeout(10_000)
    }).then((response) => {
      if (!response.ok) {
        throw new Error(`GitHub request failed with HTTP ${response.status}`);
      }
      return response;
    });
  }
}

export function parseGitHubRepository(
  repository: string
): GitHubRepository | null {
  try {
    const url = new URL(repository);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const parts = url.pathname
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .split("/")
      .filter(Boolean);
    if (parts.length !== 2) return null;
    const [owner, repo] = parts;
    return {
      owner,
      repo,
      url: `https://github.com/${owner}/${repo}`
    };
  } catch {
    return null;
  }
}

export function normalizeVersion(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/^v/i, "").toLowerCase();
  return normalized || null;
}

export function markNewerReleases(
  releases: RawProjectRelease[],
  currentVersion: string | null
): ProjectRelease[] {
  const normalizedCurrent = normalizeVersion(currentVersion);
  const currentIndex = normalizedCurrent
    ? releases.findIndex(
        (release) => normalizeVersion(release.tagName) === normalizedCurrent
      )
    : -1;
  return releases.map((release, index) => ({
    ...release,
    isNewerThanCurrent: currentIndex < 0 ? null : index < currentIndex
  }));
}

function isPublishedRelease(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const release = value as Record<string, unknown>;
  return (
    release.draft !== true &&
    release.prerelease !== true &&
    Boolean(stringValue(release.tag_name))
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
