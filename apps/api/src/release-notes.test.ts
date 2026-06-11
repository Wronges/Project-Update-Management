import { describe, expect, it, vi } from "vitest";
import {
  markNewerReleases,
  normalizeVersion,
  parseGitHubRepository,
  ReleaseNotesService
} from "./release-notes.js";

describe("release notes helpers", () => {
  it.each([
    [
      "https://github.com/owner/repo",
      { owner: "owner", repo: "repo", url: "https://github.com/owner/repo" }
    ],
    [
      "https://github.com/owner/repo.git",
      { owner: "owner", repo: "repo", url: "https://github.com/owner/repo" }
    ],
    [
      "https://github.com/owner/repo/",
      { owner: "owner", repo: "repo", url: "https://github.com/owner/repo" }
    ]
  ])("parses GitHub repository URL %s", (url, expected) => {
    expect(parseGitHubRepository(url)).toEqual(expected);
  });

  it("rejects non-GitHub repository URLs", () => {
    expect(parseGitHubRepository("https://gitlab.com/owner/repo")).toBeNull();
  });

  it("normalizes versions and marks releases before the current version", () => {
    expect(normalizeVersion("V1.2.3")).toBe("1.2.3");
    const releases = markNewerReleases(
      [
        release("v1.3.0"),
        release("V1.2.3"),
        release("v1.2.0")
      ],
      "1.2.3"
    );
    expect(releases.map((item) => item.isNewerThanCurrent)).toEqual([
      true,
      false,
      false
    ]);
  });

  it("uses null when the current version is absent", () => {
    expect(
      markNewerReleases([release("v2.0.0"), release("v1.0.0")], "0.9.0").map(
        (item) => item.isNewerThanCurrent
      )
    ).toEqual([null, null]);
  });
});

describe("ReleaseNotesService", () => {
  it("caches responses and returns stale data after a refresh failure", async () => {
    let now = Date.parse("2026-06-11T00:00:00Z");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json([
          {
            tag_name: "v1.2.0",
            name: "Release 1.2.0",
            published_at: "2026-06-10T00:00:00Z",
            html_url: "https://github.com/owner/repo/releases/tag/v1.2.0",
            body: "Fixes",
            draft: false,
            prerelease: false
          }
        ])
      )
      .mockRejectedValueOnce(new Error("network unavailable"));
    const service = new ReleaseNotesService({
      fetcher,
      now: () => now,
      ttlMs: 1000
    });

    const first = await service.get("https://github.com/owner/repo");
    const cached = await service.get("https://github.com/owner/repo");
    expect(cached).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);

    now += 1001;
    const stale = await service.get("https://github.com/owner/repo");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(stale.stale).toBe(true);
    expect(stale.error).toBe("network unavailable");
    expect(stale.releases).toEqual(first.releases);

    await service.get("https://github.com/owner/repo");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses a two-minute negative cache after an initial failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("network unavailable"));
    const service = new ReleaseNotesService({ fetcher });

    await service.get("https://github.com/owner/repo");
    await service.get("https://github.com/owner/repo");

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("falls back to tags and marks the result source", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json([{ name: "v2.0.0" }]));
    const service = new ReleaseNotesService({ fetcher });

    const result = await service.get("https://github.com/owner/repo");

    expect(result.source).toBe("github-tags");
    expect(result.releases[0]?.tagName).toBe("v2.0.0");
  });

  it("falls back to the repository releases page when html_url is missing", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json([
        {
          tag_name: "v1.0.0",
          name: "v1.0.0",
          published_at: "2026-06-10T00:00:00Z",
          body: "",
          draft: false,
          prerelease: false
        }
      ])
    );
    const service = new ReleaseNotesService({ fetcher });

    const result = await service.get("https://github.com/owner/repo");

    expect(result.releases[0]?.htmlUrl).toBe(
      "https://github.com/owner/repo/releases"
    );
  });
});

function release(tagName: string) {
  return {
    tagName,
    name: tagName,
    publishedAt: "2026-06-01T00:00:00Z",
    htmlUrl: `https://github.com/owner/repo/releases/tag/${tagName}`,
    body: ""
  };
}
