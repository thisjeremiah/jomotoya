// Layer 1 data + Layer 6 documents.
//
// The manifest is the source of truth for the world's shape. The documents are
// real HTML/CSS (React nodes here) rendered crisply in the reading panel —
// never through the canvas/dither pipeline. Internal links are physical routes
// (they trigger travel); external links open normally.
//
// All content below is placeholder. Editing a node/edge here reshapes the world;
// no rendering code needs to change.

import type { Manifest } from "@/road/manifest";
import type { ReactNode } from "react";

export const manifest: Manifest = {
  seed: 42,
  start: "home",
  nodes: [
    { id: "home", label: "Home", title: "The Road Site" },
    { id: "essays", label: "Essays", title: "Essays" },
    { id: "music", label: "Music", title: "Music" },
    { id: "colophon", label: "Colophon", title: "Colophon" },
  ],
  edges: [
    { from: "home", to: "essays", road: "highway", choice: "The essays — uphill" },
    { from: "home", to: "music", road: "backroad", choice: "The music — toward the coast" },
    { from: "home", to: "colophon", road: "backroad", choice: "How this was made" },
    { from: "essays", to: "home", road: "highway", choice: "Back to the junction" },
    { from: "music", to: "home", road: "backroad", choice: "Back to the junction" },
    { from: "colophon", to: "home", road: "backroad", choice: "Back to the junction" },
  ],
};

export interface Doc {
  kicker: string;
  title: string;
  render: (nav: (nodeId: string) => void) => ReactNode;
}

/** A styled internal link that triggers travel instead of navigating the URL. */
function Route({ to, nav, children }: { to: string; nav: (id: string) => void; children: ReactNode }) {
  return (
    <button className="route" onClick={() => nav(to)}>
      {children}
      <span aria-hidden> →</span>
    </button>
  );
}

export const docs: Record<string, Doc> = {
  home: {
    kicker: "Landmark 00",
    title: "The Road Site",
    render: (nav) => (
      <>
        <p>
          Everything here has a place. Each document is a landmark somewhere
          along the road, and this one is home.
        </p>
        <p>
          Placeholder text standing in for a real home page — a few words while
          the engine idles and the world holds still around you.
        </p>
        <nav className="routes">
          <Route to="essays" nav={nav}>Read the essays</Route>
          <Route to="music" nav={nav}>Hear the music</Route>
          <Route to="colophon" nav={nav}>See how it was built</Route>
        </nav>
        <p className="muted">
          External links behave normally — here is{" "}
          <a href="https://en.wikipedia.org/wiki/Pseudo-3D" target="_blank" rel="noreferrer">
            pseudo-3D
          </a>{" "}
          on Wikipedia.
        </p>
      </>
    ),
  },
  essays: {
    kicker: "Landmark 01 — uphill",
    title: "Essays",
    render: (nav) => (
      <>
        <p>
          A district of longer writing. Imagine an index of pieces here; for now
          this is a single placeholder standing at the top of the hill.
        </p>
        <ul className="index">
          <li>
            <span className="idx-title">On roads that are also arguments</span>
            <span className="idx-meta">placeholder · 8 min</span>
          </li>
          <li>
            <span className="idx-title">The stability of ordered dithering</span>
            <span className="idx-meta">placeholder · 5 min</span>
          </li>
          <li>
            <span className="idx-title">Camera work as narration</span>
            <span className="idx-meta">placeholder · 6 min</span>
          </li>
        </ul>
        <p>
          When you are done, the road only goes one way from here:{" "}
          <Route to="home" nav={nav}>back to the junction</Route>.
        </p>
      </>
    ),
  },
  music: {
    kicker: "Landmark 02 — the coast",
    title: "Music",
    render: (nav) => (
      <>
        <p>
          The drone you heard on the way in is procedural — two detuned
          oscillators and a little filtered noise. This district is where finished
          tracks would live. Placeholder for now.
        </p>
        <ol className="index">
          <li>
            <span className="idx-title">Untitled (engine, wind)</span>
            <span className="idx-meta">placeholder</span>
          </li>
          <li>
            <span className="idx-title">Filter sweep in G</span>
            <span className="idx-meta">placeholder</span>
          </li>
        </ol>
        <p>
          <Route to="home" nav={nav}>Return to the junction</Route>
        </p>
      </>
    ),
  },
  colophon: {
    kicker: "Landmark 03",
    title: "Colophon",
    render: (nav) => (
      <>
        <p>
          Rendered on a 320×240 offscreen canvas, reduced to grayscale, dithered
          with a 4×4 Bayer matrix, and upscaled with hard pixels. The road is a
          classic segment-based pseudo-3D projection — no WebGL.
        </p>
        <p>
          The world is deterministic: the same <code>seed</code> plus this
          manifest always generate the same curves, hills, and roadside detail.
          Add a node and an edge to the manifest and a new landmark appears down a
          new road — nothing about the renderer changes.
        </p>
        <p>
          <Route to="home" nav={nav}>Back to the junction</Route>
        </p>
      </>
    ),
  },
};
