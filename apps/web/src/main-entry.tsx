import { createRoot } from "react-dom/client";

import App from "@/main";

const rootElement = document.querySelector<HTMLDivElement>("#root");
if (!rootElement) {
  throw new Error("Could not find the application root element.");
}

createRoot(rootElement).render(<App />);
