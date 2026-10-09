import { ChevronLeft } from "lucide-react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { Link } from "react-router-dom";

export function Page({ title, back, action, children }: { title: string; back?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <>
      <header className="mb-5">
        {back && (
          <Link to={back} className="-ml-2 mb-1 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-muted hover:text-ink">
            <ChevronLeft size={20} aria-hidden /> Back
          </Link>
        )}
        <div className="flex items-center justify-between gap-3">
          <h1 className="display text-3xl font-extrabold text-accent-text">{title}</h1>
          {action}
        </div>
      </header>
      {children}
    </>
  );
}

export function Card({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`mb-4 rounded-2xl border border-line bg-surface p-4 ${className}`} aria-label={title}>
      {title && <h2 className="display mb-3 text-lg font-bold">{title}</h2>}
      {children}
    </section>
  );
}

const base = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 font-bold disabled:opacity-50";
export const btn = {
  primary: `${base} bg-accent-strong text-white`,
  secondary: `${base} border border-line bg-sunken`,
  quiet: `${base} text-accent-text hover:bg-sunken`,
};

export function Button({ variant = "secondary", className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof btn }) {
  return <button type="button" className={`${btn[variant]} ${className}`} {...rest} />;
}

const control = "mt-1 block min-h-11 w-full rounded-xl border border-line bg-ground px-3 text-ink";

export function TextField({ label, hint, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="mb-3 block">
      <span className="font-bold">{label}</span>
      {hint && <span className="block text-sm text-muted">{hint}</span>}
      <input className={control} {...rest} />
    </label>
  );
}

export function SelectField({ label, options, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; options: [string, string][] }) {
  return (
    <label className="mb-3 block">
      <span className="font-bold">{label}</span>
      <select className={control} {...rest}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

/** A checkbox styled as a chip. Space toggles it; focus shows a ring. */
export function Chip({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`inline-flex ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="inline-flex min-h-11 items-center rounded-full border border-line bg-sunken px-3 peer-checked:border-accent-strong peer-checked:bg-accent-strong peer-checked:font-bold peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-accent">
        {label}
      </span>
    </label>
  );
}

/** A segmented choice between a few values, as radio buttons. */
export function Segmented<T extends string>({ label, name, value, options, onChange }: { label: string; name: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <fieldset className="mb-3">
      <legend className="font-bold">{label}</legend>
      <div className="mt-1 grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map(([v, l]) => (
          <label key={v} className="flex">
            <input type="radio" name={name} className="peer sr-only" checked={value === v} onChange={() => onChange(v)} />
            <span className="flex min-h-11 w-full cursor-pointer items-center justify-center rounded-xl border border-line bg-sunken px-3 peer-checked:border-accent-strong peer-checked:bg-accent-strong peer-checked:font-bold peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-accent">
              {l}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Badge({ children, tone = "accent" }: { children: ReactNode; tone?: "accent" | "muted" }) {
  return (
    <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ${tone === "accent" ? "bg-accent-strong text-white" : "bg-sunken text-muted"}`}>
      {children}
    </span>
  );
}

export function Loading() {
  return <p className="text-muted" role="status">Loading...</p>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p role="alert" className="my-3 whitespace-pre-line font-bold text-over">{(error as Error).message}</p>;
}
