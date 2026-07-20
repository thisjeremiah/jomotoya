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
  const [prompt, setPrompt] = useState<string | null>(null);
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
      onPrompt: setPrompt,
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
    const down = (e: KeyboardEvent) => {
      const eng = engineRef.current;
      if (!eng) return;
      if (reading) {
        if (e.key === "Escape" || e.key === "Enter") {
          e.preventDefault();
          eng.leaveReading();
        }
        return;
      }
      if (fork) {
        if (e.key >= "1" && e.key <= String(fork.length)) eng.chooseFork(Number(e.key) - 1);
        else if (e.key === "ArrowLeft") eng.chooseFork(0);
        else if (e.key === "ArrowRight") eng.chooseFork(fork.length - 1);
        return;
      }
      // Pull off to read the landmark ahead (opt-in).
      if (prompt && (e.key === "Enter" || e.key === " " || e.key === "ArrowUp")) {
        e.preventDefault();
        eng.pullOff();
        return;
      }
      // Steer.
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
  }, [reading, fork, prompt]);

  const begin = () => {
    engineRef.current?.enableAudio();
    setStarted(true);
  };

  const holdSteer = (dir: -1 | 1) => (e: React.PointerEvent) => {
    e.preventDefault();
    engineRef.current?.steer(dir);
  };
  const releaseSteer = (e: React.PointerEvent) => {
    e.preventDefault();
    engineRef.current?.steer(0);
  };

  const doc = reading ? docs[reading] : null;
  const showDriveUI = started && !reading && !fork;

  return (
    <div ref={containerRef} className="road-root">
      <canvas ref={canvasRef} className="road-canvas" />

      {!readMode && <div className="frame-grain" aria-hidden />}

      {/* Start gate — the gesture that enables audio. */}
      {!started && (
        <div className="start-gate" onClick={begin}>
          <div className="start-inner">
            <h1>THE ROAD SITE</h1>
            <p>Documents are landmarks. Drive the road; pull off at one to read it — or just keep driving.</p>
            <button className="start-btn" onClick={begin}>Start the drive</button>
            <p className="keys">← → steer · ↑ / Enter pull off · Esc leave</p>
          </div>
        </div>
      )}

      {/* Pull-off prompt (opt-in). */}
      {showDriveUI && prompt && (
        <button className="pull-off" onClick={() => engineRef.current?.pullOff()}>
          <span className="pull-key">↑</span>
          Pull off to read <strong>{prompt}</strong>
        </button>
      )}

      {/* HUD hint. */}
      {showDriveUI && !prompt && (
        <div className="hud">{state === "FOCUS" ? "Arriving…" : "Driving — keep going or pull off ahead"}</div>
      )}

      {/* Touch / click steering. */}
      {showDriveUI && (
        <div className="touch-steer" aria-hidden>
          <button
            className="steer-btn left"
            onPointerDown={holdSteer(-1)}
            onPointerUp={releaseSteer}
            onPointerLeave={releaseSteer}
            onPointerCancel={releaseSteer}
          >
            ←
          </button>
          <button
            className="steer-btn right"
            onPointerDown={holdSteer(1)}
            onPointerUp={releaseSteer}
            onPointerLeave={releaseSteer}
            onPointerCancel={releaseSteer}
          >
            →
          </button>
        </div>
      )}

      {/* Fork chooser. */}
      {started && fork && !reading && (
        <>
          <div className="hud">Choose a road</div>
          <div className="fork">
            {fork.map((opt, i) => (
              <button key={opt.edge.to} className="fork-btn" onClick={() => engineRef.current?.chooseFork(i)}>
                <span className="fork-num">{i + 1}</span>
                {opt.label}
              </button>
            ))}
          </div>
        </>
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
            <div className="reader-body">{doc.render((nodeId) => engineRef.current?.travelTo(nodeId))}</div>
          </article>
        </div>
      )}
    </div>
  );
}
