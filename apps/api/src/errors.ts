export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Unknown project: ${projectId}`);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectConflictError";
  }
}
