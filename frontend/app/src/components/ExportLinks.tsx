import { Capacitor } from "@capacitor/core";
import { Download } from "lucide-react";
import { useState } from "react";
import { API_BASE } from "../lib/api";
import { Button, btn } from "./ui";

/**
 * Download buttons for an export, in both formats. Exports are files from the
 * server, so they work in a browser only (desktop or a phone's browser). In
 * the Android app this says so and shows the address to open instead.
 */
export function ExportLinks({ path, page, what }: { path: string; page: string; what: string }) {
  const [copied, setCopied] = useState(false);
  if (Capacitor.isNativePlatform()) {
    const address = `${API_BASE || window.location.origin}${page}`;
    return (
      <div>
        <p className="mb-2">Exporting works in a browser, on your computer or your phone. Open this address there:</p>
        <p className="mb-3 break-all rounded-xl bg-sunken p-3 font-bold">{address}</p>
        <Button className="w-full" onClick={() => void navigator.clipboard?.writeText(address).then(() => setCopied(true), () => {})}>
          {copied ? "Copied" : "Copy address"}
        </Button>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      <a href={`${path}?format=csv`} download className={btn.secondary}>
        <Download size={18} aria-hidden /> CSV<span className="sr-only"> of {what}</span>
      </a>
      <a href={`${path}?format=json`} download className={btn.secondary}>
        <Download size={18} aria-hidden /> JSON<span className="sr-only"> of {what}</span>
      </a>
    </div>
  );
}
