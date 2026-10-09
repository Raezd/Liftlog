import { Capacitor } from "@capacitor/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Download } from "./Download";
import { Hello } from "./Hello";
import { TimerTest } from "./timer/TimerTest";
import "./styles.css";

// The Android app shows the rest timer test (temporary, Spec 2). The web
// build shows the hello page, plus /download for the Android app.
function Root() {
  if (Capacitor.isNativePlatform()) return <TimerTest />;
  if (window.location.pathname === "/download") return <Download />;
  return <Hello />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
