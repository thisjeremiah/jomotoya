"use client";

import { useEffect, useRef, useState } from "react";
import { RoadEngine, type DriveState, type ForkOption } from "@/road/engine";
import { validateManifest } from "@/road/manifest";
import { manifest, docs } from "@/content/site";

export default function RoadSite() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<RoadEngine | null>(null);

  const [started, setStarted] = useState(false);
  const [state, setState] = useState<DriveState>("DRIVING");
  const [reading, setReading] = useState<string | null>(null);
  const [fork, setFork] = useState<ForkOption[] | null>(null);
  const [readMode, setReadMode] = useState(false);

  // Instantiate the engine once the canvas exists.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    validateManifest(manifest);
    const engine = new RoadEngine(canvas, manifest, {
      onReading: setReading,
      onFork: setFork,
      onState: setState,
    });
    engineRef.current = engine;

    const doResize = () => engine.resize(container.clientWidth, container.clientHeight);
    doResize();
    const ro = new ResizeObserver(doResize);
    ro.observe(container);
    engine.start();

    return () => {
      ro.disconnect();
      engine.stop();
      engineRef.current = null;
    };
  }, []);

  // Keyboard controls.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    const down = (e: KeyboardEvent) => {
      const eng = engineRef.current;
      if (!eng) return;
      // Reading: Esc / Enter leaves.
      if (reading) {
        if (e.key === "Escape" || e.key === "Enter") {
          e.preventDefault();
          eng.leaveReading();
        }
        return;
      }
      // Fork: number keys or left/right pick.
      if (fork) {
        if (e.key >= "1" && e.key <= String(fork.length)) {
          eng.chooseFork(Number(e.key) - 1);
        } else if (e.key === "ArrowLeft") {
          eng.chooseFork(0);
        } else if (e.key === "ArrowRight") {
          eng.chooseFork(fork.length - 1);
        }
        return;
      }
      // Driving: steer.
      if (e.key === "ArrowLeft" || e.key === "a") eng.steer(-1);
      else if (e.key === "ArrowRight" || e.key === "d") eng.steer(1);
    };
    const up = (e: KeyboardEvent) => {
      const eng = engineRef.current;
      if (!eng || reading || fork) return;
      if (["ArrowLeft", "ArrowRight", "a", "d"].includes(e.key)) eng.steer(0);
    };

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [reading, fork]);

  const begin = () => {
    engineRef.current?.enableAudio();
    setStarted(true);
  };

  const doc = reading ? docs[reading] : null;

  return (
    <div ref={containerRef} className="road-root">
      <canvas ref={canvasRef} className="road-canvas" />

      {/* Ambient framing over the whole scene (skipped in read mode). */}
      {!readMode && <div className="frame-grain" aria-hidden />}

      {/* Start gate — needed as the audio-enabling gesture. */}
      {!started && (
        <div className="start-gate" onClick={begin}>
          <div className="start-inner">
            <h1>THE ROAD SITE</h1>
            <p>
              Documents are landmarks. Drive to one and pull off to read it.
            </p>
            <button className="start-btn" onClick={begin}>
              Start the drive
            </button>
            <p className="keys">
              ← → steer / choose · Enter or Esc to leave a landmark
            </p>
          </div>
        </div>
      )}

      {/* HUD hint line. */}
      {started && !reading && (
        <div className="hud">
          {fork
            ? "Choose a road"
            : state === "FOCUS"
              ? "Arriving…"
              : "Driving — a landmark is ahead"}
        </div>
      )}

      {/* Fork chooser. */}
      {started && fork && !reading && (
        <div className="fork">
          {fork.map((opt, i) => (
            <button key={opt.edge.to} className="fork-btn" onClick={() => engineRef.current?.chooseFork(i)}>
              <span className="fork-num">{i + 1}</span>
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {/* Reading panel — real, crisp DOM. */}
      {doc && (
        <div className={`reader ${readMode ? "read-mode" : ""}`} role="dialog" aria-modal="true">
          <article className="reader-panel">
            <header className="reader-head">
              <span className="kicker">{doc.kicker}</span>
              <div className="reader-tools">
                <button className="tool" onClick={() => setReadMode((v) => !v)}>
                  {readMode ? "Framing on" : "Read mode"}
                </button>
                <button className="tool" onClick={() => engineRef.current?.leaveReading()}>
                  Back to the road ✕
                </button>
              </div>
            </header>
            <h1 className="reader-title">{doc.title}</h1>
            <div className="reader-body">
              {doc.render((nodeId) => engineRef.current?.travelTo(nodeId))}
            </div>
          </article>
        </div>
      )}
    </div>
  );
}
