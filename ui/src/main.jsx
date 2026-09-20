import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./tailwind.css";   // scoped Tailwind (preflight off) — must load before styles.css
import "./styles.css";     // existing dashboard styles win on any conflict

// Global error boundary: a component crash shows a readable error panel,
// never a blank page.
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) return (
      <div style={{ margin: 40, padding: 24, background: "#fdeeee", border: "1px solid #c62828", borderRadius: 12, fontFamily: "monospace", fontSize: 13 }}>
        <b>Dashboard error</b> — please screenshot this:
        <pre style={{ whiteSpace: "pre-wrap" }}>{String(this.state.err?.stack || this.state.err)}</pre>
      </div>
    );
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(<Boundary><App /></Boundary>);
