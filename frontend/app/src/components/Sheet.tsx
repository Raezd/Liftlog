import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

/** A modal panel: a bottom sheet on phones, centered on wider screens.
 *  Built on <dialog>, so focus stays inside and Escape closes it. */
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-label={title}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className="m-0 mt-auto max-h-[85dvh] w-full max-w-none rounded-t-2xl border border-line bg-surface p-0 text-ink backdrop:bg-black/50 sm:m-auto sm:max-w-md sm:rounded-2xl">
      {open && (
        <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="display text-xl font-bold">{title}</h2>
            <button type="button" onClick={onClose} className="inline-flex size-11 items-center justify-center rounded-xl hover:bg-sunken">
              <X size={20} aria-hidden /><span className="sr-only">Close</span>
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
