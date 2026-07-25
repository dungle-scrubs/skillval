import { createRoot } from "react-dom/client";
import { PAYLOAD_GLOBAL, type ReportPayload } from "../src/report-payload.js";
import { App } from "./app";
import "./styles.css";

declare global {
  interface Window {
    readonly [PAYLOAD_GLOBAL]: ReportPayload;
  }
}

const root = document.getElementById("root");
if (root === null) throw new Error("report shell is missing #root");
createRoot(root).render(<App payload={window[PAYLOAD_GLOBAL]} />);
