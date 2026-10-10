import { Chip, Button } from "./ui";
import { Sheet } from "./Sheet";
import { plateMath, weightText, type Loading } from "../lib/plates";
import type { Bar, PlateSet, WeightUnit } from "../lib/types";

/** Plates per side, heaviest first, as a plain list. */
function LoadingView({ load, unit, bar }: { load: Loading; unit: WeightUnit; bar: Bar }) {
  return (
    <div>
      <h3 className="font-bold">Each side</h3>
      {load.perSide.length === 0 ? (
        <p className="num text-lg">No plates</p>
      ) : (
        <ul className="num text-lg">
          {load.perSide.map((p) => (
            <li key={`${p.weight_value}${p.weight_unit}`}>
              <span className="font-bold">{weightText(p)}</span>
              <span aria-hidden> x {p.count}</span>
              <span className="sr-only">, {p.count === 1 ? "1 plate" : `${p.count} plates`}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="num text-muted">Bar {weightText(bar)}, total {load.total} {unit}</p>
    </div>
  );
}

/**
 * Plate math for one set, from the weight field's plate button. Works offline:
 * the gear comes from the phone's copy. Plates left out here apply to every
 * exercise in this workout and never change the saved gear.
 */
export function PlateSheet({ open, onClose, value, unit, bar, plateSet, excluded, onExclude, onUse }: {
  open: boolean;
  onClose: () => void;
  value: string;
  unit: WeightUnit;
  bar: Bar | undefined;
  plateSet: PlateSet | undefined;
  excluded: string[];
  onExclude: (plateId: string, out: boolean) => void;
  /** Sets this set's weight. */
  onUse: (total: string) => void;
}) {
  const result = bar && plateSet ? plateMath({ value, unit }, bar, plateSet.plates, excluded) : null;
  const shown = plateSet?.plates.filter((p) => p.enabled) ?? [];
  const left = shown.filter((p) => excluded.includes(p.id));
  return (
    <Sheet open={open} title={value.trim() ? `Plates for ${value.trim()} ${unit}` : "Plates"} onClose={onClose}>
      {!bar || !plateSet ? (
        <p>Your bars and plates aren't on this phone yet. Open Liftlog once with a connection.</p>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted">{bar.name}, {weightText(bar)}. {plateSet.name}.</p>
          <div role="status" className="mb-4 rounded-xl bg-sunken p-3">
            {result === null ? (
              <p>Type a weight to see the plates.</p>
            ) : result.kind === "below_bar" ? (
              <>
                <p className="mb-2 font-bold">{value.trim()} {unit} is less than the bar, which is {weightText(bar)}.</p>
                <h3 className="font-bold">Each side</h3>
                <p className="num text-lg">No plates</p>
                <p className="num text-muted">Empty bar, {weightText(bar)}</p>
              </>
            ) : result.kind === "exact" ? (
              <LoadingView load={result.load} unit={unit} bar={bar} />
            ) : (
              <>
                <p className="mb-3 font-bold">These plates can't make {value.trim()} {unit}. Closest:</p>
                <div className="grid grid-cols-2 gap-2">
                  {([["below", result.below], ["above", result.above]] as const).map(([k, load]) => (
                    <div key={k}>
                      {load ? (
                        <>
                          <Button variant="primary" className="num mb-2 w-full" onClick={() => onUse(load.total)}>
                            {load.total} {unit}<span className="sr-only">. Use this weight</span>
                          </Button>
                          <LoadingView load={load} unit={unit} bar={bar} />
                        </>
                      ) : (
                        <p className="text-sm text-muted">Nothing heavier with these plates.</p>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
            {left.length > 0 && (
              <p className="mt-2 text-sm">Left out this workout: {left.map(weightText).join(", ")}</p>
            )}
          </div>
          {shown.length > 0 && (
            <fieldset>
              <legend className="font-bold">Plates you have here</legend>
              <p className="mb-2 text-sm text-muted">Uncheck a plate to leave it out for this workout. Your saved plates don't change.</p>
              <div className="flex flex-wrap gap-2">
                {shown.map((p) => (
                  <Chip key={p.id} label={weightText(p)} checked={!excluded.includes(p.id)} onChange={(on) => onExclude(p.id, !on)} />
                ))}
              </div>
            </fieldset>
          )}
        </>
      )}
    </Sheet>
  );
}
