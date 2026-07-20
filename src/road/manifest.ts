// Layer 1 — Content Graph (source of truth).
//
// Nodes are documents/landmarks. Edges are the roads between them. This is the
// only thing maintained by hand day-to-day; everything spatial (curves, hills,
// roadside detail) is generated deterministically from `seed + manifest`.

export type RoadKind = "highway" | "backroad";

export interface ManifestNode {
  /** Stable identifier, referenced by edges and internal links. */
  id: string;
  /** Short label rendered on the landmark billboard. */
  label: string;
  /** Longer title shown at the top of the reading panel. */
  title: string;
  /** Optional pin for future auto-layout; unused by the MVP renderer. */
  pin?: [number, number];
}

export interface ManifestEdge {
  from: string;
  to: string;
  road: RoadKind;
  /** Human label for the fork choice that leads down this edge. */
  choice?: string;
}

export interface Manifest {
  seed: number;
  nodes: ManifestNode[];
  edges: ManifestEdge[];
  /** Where the drive begins. */
  start: string;
}

/**
 * Cheap structural validation. The point of a schema-validated manifest is to
 * reject bad (possibly AI-authored) input loudly instead of debugging garbage
 * geometry later. Throws on the first problem it finds.
 */
export function validateManifest(m: Manifest): Manifest {
  if (typeof m.seed !== "number") throw new Error("manifest.seed must be a number");
  if (!Array.isArray(m.nodes) || m.nodes.length === 0)
    throw new Error("manifest.nodes must be a non-empty array");
  if (!Array.isArray(m.edges)) throw new Error("manifest.edges must be an array");

  const ids = new Set<string>();
  for (const n of m.nodes) {
    if (!n.id) throw new Error("every node needs an id");
    if (ids.has(n.id)) throw new Error(`duplicate node id: ${n.id}`);
    ids.add(n.id);
  }
  for (const e of m.edges) {
    if (!ids.has(e.from)) throw new Error(`edge.from references unknown node: ${e.from}`);
    if (!ids.has(e.to)) throw new Error(`edge.to references unknown node: ${e.to}`);
  }
  if (!ids.has(m.start)) throw new Error(`manifest.start references unknown node: ${m.start}`);
  return m;
}

/** Outgoing edges for a node, in declaration order (fork order). */
export function edgesFrom(m: Manifest, nodeId: string): ManifestEdge[] {
  return m.edges.filter((e) => e.from === nodeId);
}

export function nodeById(m: Manifest, id: string): ManifestNode {
  const n = m.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node with id ${id}`);
  return n;
}
