import { publishFixture, type PublishedPackage } from "./fixtures.js";
import { createToken } from "./stack.js";

export interface DependencyGraphFixture {
  readonly token: string;
  readonly core: PublishedPackage;
  readonly util: PublishedPackage;
  readonly app: PublishedPackage;
  readonly coordinate: string;
}

const GRAPH_FIXTURE = {
  core: {
    org: "graph-e2e",
    name: "graph-core",
    version: "1.0.0",
    description: "Shared foundation for dependency graph browser tests",
  },
  util: {
    org: "graph-e2e",
    name: "graph-util",
    version: "1.1.0",
    description: "Utility package with one declared dependency",
  },
  app: {
    org: "graph-e2e",
    name: "graph-app",
    version: "2.0.0-beta.1",
    description: "Pre-release application with a branching dependency graph",
  },
} as const satisfies Record<string, PublishedPackage>;

let seeded: DependencyGraphFixture | undefined;

/**
 * Publish a deterministic three-package graph through the real CLI and API.
 *
 * The fixture deliberately contains both a direct edge to graph-core and a
 * second path through graph-util. That gives the browser enough topology to
 * exercise direct, transitive, reverse-impact, shortest-path, and expansion
 * controls without synthesizing graph data in the test process.
 */
export async function ensureDependencyGraphSeeded(): Promise<DependencyGraphFixture> {
  if (seeded !== undefined) return seeded;

  const token = await createToken(
    `e2e-graph-${Date.now().toString(36)}`,
    GRAPH_FIXTURE.app.org,
  );
  await publishFixture(GRAPH_FIXTURE.core, {
    token,
    allowExisting: true,
  });
  await publishFixture(GRAPH_FIXTURE.util, {
    token,
    allowExisting: true,
    deps: {
      "graph-e2e/graph-core": "^1.0.0",
    },
  });
  await publishFixture(GRAPH_FIXTURE.app, {
    token,
    allowExisting: true,
    deps: {
      "graph-e2e/graph-core": "^1.0.0",
      "graph-e2e/graph-util": "^1.1.0",
    },
  });

  seeded = {
    token,
    core: GRAPH_FIXTURE.core,
    util: GRAPH_FIXTURE.util,
    app: GRAPH_FIXTURE.app,
    coordinate: `${GRAPH_FIXTURE.app.org}/${GRAPH_FIXTURE.app.name}@${GRAPH_FIXTURE.app.version}`,
  };
  return seeded;
}
