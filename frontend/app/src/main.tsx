import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Hello } from "./Hello";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Hello />
  </StrictMode>,
);
