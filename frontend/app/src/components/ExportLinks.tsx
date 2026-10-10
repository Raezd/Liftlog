import { Capacitor } from "@capacitor/core";
import { Download, ExternalLink } from "lucide-react";
import { API_BASE } from "../lib/api";
import { btn } from "./ui";

/**
 * Download buttons for an export, in both formats. Exports are files from the
 * server, so they work in a browser only (desktop or a phone's browser). In
 * the Android app this is a button that opens the same page in the phone's
 * browser: Capacitor hands a link to any other host to the system (an
 * ACTION_VIEW intent, Bridge.launchIntent), so no plugin is needed.
 */
export function ExportLinks({ path, page, what }: { path: string; page: string; what: string }) {
  if (Capacitor.isNativePlatform()) {
    return (
      <div>
        <p className="mb-3">Exporting works in a browser. This opens the export page in your phone's browser.</p>
        <a href={`${API_BASE || window.location.origin}${page}`} className={`${btn.primary} w-full`}>
          <ExternalLink size={18} aria-hidden /> Open in browser<span className="sr-only"> to export {what}</span>
        </a>
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
