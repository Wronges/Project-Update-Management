import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { ProjectStatus } from "@pum/shared";
import { registerProjectReleaseRoute } from "./app.js";
import { ProjectNotFoundError } from "./errors.js";

const project: ProjectStatus = {
  id: "demo",
  name: "demo",
  repository: "https://github.com/owner/repo",
  server: "primary",
  composeDirectory: "/opt/demo",
  composeService: "app",
  containerName: "demo",
  image: "owner/demo:latest",
  updatePolicy: "manual",
  updateStrategy: "image",
  runtimeStatus: "running",
  updateStatus: "update_available",
  runningImageId: "sha256:old",
  latestImageId: "sha256:new",
  runningVersion: "1.0.0",
  latestVersion: "1.1.0",
  runningImageCreatedAt: "2026-05-01T00:00:00Z",
  latestImageCreatedAt: "2026-06-01T00:00:00Z",
  lastCheckedAt: null,
  lastUpdatedAt: null
};

describe("GET /api/projects/:id/releases", () => {
  it("returns release notes with project versions", async () => {
    const app = Fastify();
    registerProjectReleaseRoute(
      app,
      {
        get(id) {
          if (id !== project.id) throw new ProjectNotFoundError(id);
          return project;
        }
      },
      {
        async get() {
          return {
            repository: project.repository,
            source: "github",
            releases: [
              {
                tagName: "v1.1.0",
                name: "1.1.0",
                publishedAt: "2026-06-01T00:00:00Z",
                htmlUrl: `${project.repository}/releases/tag/v1.1.0`,
                body: "Changes"
              },
              {
                tagName: "v1.0.0",
                name: "1.0.0",
                publishedAt: "2026-05-01T00:00:00Z",
                htmlUrl: `${project.repository}/releases/tag/v1.0.0`,
                body: ""
              }
            ],
            fetchedAt: "2026-06-11T00:00:00Z"
          };
        }
      }
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/projects/demo/releases"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      currentVersion: "1.0.0",
      latestLocalVersion: "1.1.0",
      releases: [
        { tagName: "v1.1.0", isNewerThanCurrent: true },
        { tagName: "v1.0.0", isNewerThanCurrent: false }
      ]
    });
    await app.close();
  });

  it("returns 404 for an unknown project", async () => {
    const app = Fastify();
    registerProjectReleaseRoute(
      app,
      {
        get(id) {
          throw new ProjectNotFoundError(id);
        }
      },
      {
        async get() {
          throw new Error("must not be called");
        }
      }
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/projects/missing/releases"
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("does not mark unordered tag fallback entries as newer", async () => {
    const app = Fastify();
    registerProjectReleaseRoute(
      app,
      { get: () => project },
      {
        async get() {
          return {
            repository: project.repository,
            source: "github-tags",
            releases: [
              {
                tagName: "v1.1.0",
                name: "v1.1.0",
                publishedAt: null,
                htmlUrl: project.repository,
                body: ""
              }
            ],
            fetchedAt: "2026-06-11T00:00:00Z"
          };
        }
      }
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/projects/demo/releases"
    });
    expect(response.json().releases[0].isNewerThanCurrent).toBeNull();
    await app.close();
  });
});
