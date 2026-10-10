/** A set field, on the workout screen and in the workout editor. Typing
 *  anything its pattern refuses (a fifth digit before the decimal point, a
 *  third decimal) does nothing. Limits: INPUT in lib/session.ts. */
export function NumField({ id, label, value, onChange, mode, pattern, placeholder, className = "flex-1" }: {
  id?: string; label: string; value: string; onChange: (v: string) => void; mode: "decimal" | "numeric" | "text"; pattern: RegExp;
  placeholder?: string; className?: string;
}) {
  return (
    <label className={`min-w-0 ${className}`}>
      <span className="sr-only">{label}</span>
      <input id={id} inputMode={mode} value={value} placeholder={placeholder}
        onChange={(e) => { if (pattern.test(e.target.value.trim())) onChange(e.target.value.trim()); }}
        className="num block min-h-12 w-full min-w-0 rounded-xl border border-line bg-ground px-1 text-center text-lg" />
    </label>
  );
}

/** The weight column: wide enough for 9999.99 at the normal size (tabular
 *  digits are 0.63em, so about 4.5rem of text plus padding and border). */
export const WEIGHT_COL = "min-w-[5.375rem] flex-[1.4]";
