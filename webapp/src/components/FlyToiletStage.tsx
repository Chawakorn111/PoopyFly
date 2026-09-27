import { useEffect, useRef } from "react";
import type { Snapshot } from "../sim/protocol";
import { ToiletScene, type SceneLocation } from "../three/ToiletScene";

export const LOCATIONS: { id: SceneLocation; label: string }[] = [
  { id: "fuji", label: "Mount Fuji" },
  { id: "nyc", label: "New York" },
  { id: "bangkok", label: "Bangkok" },
];

// Big stage (all 3D): procedural porcelain toilet + 3D housefly on the seat +
// 3D poop that drops into the bowl and piles up. Everything is driven by real
// simulation state (pressure / defecating / relief / music / poop count) and the
// scenery is switchable (Fuji / New York / Bangkok).
export function FlyToiletStage({ snap, location, onLocation }: {
  snap: Snapshot | null;
  location: SceneLocation;
  onLocation: (l: SceneLocation) => void;
}) {
  const v = snap?.vitals;
  const m = snap?.metrics;
  const pressure = v?.gutPressure ?? 0;
  const comfort = v?.comfort ?? 1;
  const defecating = v?.defecating ?? false;
  const song = snap?.music.current ?? null;
  const action = snap?.currentAction ?? "…";
  const poopCount = m?.successPoops ?? 0;

  const desperate = pressure > 0.7 && !defecating;
  const relieved = comfort > 0.72 && !defecating && pressure < 0.35;

  const holder = useRef<HTMLDivElement | null>(null);
  const scene = useRef<ToiletScene | null>(null);

  useEffect(() => {
    if (!holder.current) return;
    const s = new ToiletScene(holder.current);
    s.setLocation(location);
    s.start();
    scene.current = s;
    return () => { s.dispose(); scene.current = null; };
  }, []); // eslint-disable-line

  useEffect(() => {
    scene.current?.setPose({ defecating, desperate, relieved, pressure, music: song, poopCount });
  }, [defecating, desperate, relieved, pressure, song, poopCount]);

  useEffect(() => { scene.current?.setLocation(location); }, [location]);

  return (
    <div className={`toiletstage ${defecating ? "pooping" : ""}`}>
      <div className="speech">{action}</div>

      <div className="locsel" role="tablist" aria-label="poop location">
        {LOCATIONS.map((l) => (
          <button key={l.id} className={location === l.id ? "on" : ""} onClick={() => onLocation(l.id)} title={`Poop at ${l.label}`}>
            {l.label}
          </button>
        ))}
      </div>

      <div className="scene3d" ref={holder} />
      <div className="gutbar" title="gut pressure">
        <span>gut</span><i style={{ width: `${pressure * 100}%` }} /><b>{pressure.toFixed(2)}</b>
        <span className="poopcnt">poop x{poopCount}</span>
      </div>
    </div>
  );
}
