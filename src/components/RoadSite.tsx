"use client";

import { useEffect, useRef, useState } from "react";
import { RoadEngine } from "@/road/engine";
import { validateManifest } from "@/road/manifest";
import { manifest, docs } from "@/content/site";

export default function RoadSite() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<RoadEngine | null>(null);

  const [reading, setReading] = useState<string | null>(null);

  // Boot the engine — it starts driving immediately, no gate.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    validateManifest(manifest);
    const engine = new RoadEngine(canvas, manifest, { onReading: setReading });
    engineRef.current = engine;

    const doResize = () => engine.resize(container.clientWidth, container.clientHeight);
    doResize();
    const ro = new ResizeObserver(doResize);
    ro.observe(container);
    engine.start();

    // Sound needs a user gesture — wake it on the first interaction, silently.
    const wake = () => engine.enableAudio();
    window.addEventListener("pointerdown", wake, { once: true });
    window.addEventListener("keydown", wake, { once: true });

    // Esc leaves a landmark (an unobtrusive escape hatch alongside clicking away).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") engine.leaveReading();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      ro.disconnect();
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
      window.removeEventListener("keydown", onKey);
      engine.stop();
      engineRef.current = null;
    };
  }, []);

  const frac = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height };
  };

  const onCanvasDown = (e: React.PointerEvent) => {
    const { fx, fy } = frac(e);
    engineRef.current?.clickAt(fx, fy);
  };

  const onCanvasMove = (e: React.PointerEvent) => {
    const eng = engineRef.current;
    if (!eng) return;
    const { fx, fy } = frac(e);
    (e.currentTarget as HTMLElement).style.cursor = eng.isOverLandmark(fx, fy) ? "pointer" : "default";
  };

  const doc = reading ? docs[reading] : null;

  return (
    <div ref={containerRef} className="road-root">
      <canvas
        ref={canvasRef}
        className="road-canvas"
        onPointerDown={onCanvasDown}
        onPointerMove={onCanvasMove}
      />

      <div className="frame-grain" aria-hidden />

      {doc && (
        <div
          className="reader"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) engineRef.current?.leaveReading();
          }}
        >
          <article className="reader-panel">
            <button
              className="reader-close"
              aria-label="Close"
              onClick={() => engineRef.current?.leaveReading()}
            >
              ✕
            </button>
            <h1 className="reader-title">{doc.title}</h1>
            <div className="reader-body">{doc.render((nodeId) => engineRef.current?.travelTo(nodeId))}</div>
          </article>
        </div>
      )}
    </div>
  );
}
