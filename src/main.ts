import { invoke } from "@tauri-apps/api/core";
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { rust } from "@codemirror/lang-rust";

type SnippetStatus = "success" | "build_error" | "run_error" | "timeout";

interface SnippetResult {
  status: SnippetStatus;
  stdout: string;
  stderr: string;
  diagnostics: string[];
  exit_code: number | null;
}

const example = `fn main() {
    let erzmengen = [0, 3, 0, 7];
    let funde: Vec<_> = erzmengen.into_iter().filter(|&menge| menge > 0).collect();
    println!("{funde:?}");
}
`;

const editorElement = document.querySelector("#editor") as HTMLElement;
const outputElement = document.querySelector("#output") as HTMLElement;

const view = new EditorView({
  doc: example,
  extensions: [basicSetup, rust(), EditorView.lineWrapping],
  parent: editorElement,
});

view.focus();

let running = false;

function renderResult(result: SnippetResult): string {
  const parts: string[] = [];

  if (result.status === "build_error") {
    parts.push(result.diagnostics.join("\n\n") || result.stderr || "Build fehlgeschlagen.");
    return parts.join("\n\n");
  }

  if (result.status === "timeout") {
    parts.push("Zeitlimit von 5 Sekunden überschritten – das Programm wurde beendet.");
  } else if (result.status === "run_error") {
    const code = result.exit_code === null ? "unbekannt" : String(result.exit_code);
    parts.push(`Programm mit Exitcode ${code} beendet.`);
  }

  if (result.stdout) {
    parts.push(result.stdout);
  }
  if (result.stderr) {
    parts.push(result.stderr);
  }
  if (parts.length === 0) {
    parts.push("(keine Ausgabe)");
  }

  return parts.join("\n\n");
}

function setOutput(text: string) {
  outputElement.textContent = text;
}

async function runSnippet() {
  if (running) {
    return;
  }
  running = true;
  setOutput("Baue und führe aus …");

  try {
    const result = await invoke<SnippetResult>("run_snippet", {
      language: "rust",
      source: view.state.doc.toString(),
    });
    setOutput(renderResult(result));
  } catch (error) {
    setOutput(`Interner Fehler: ${String(error)}`);
  } finally {
    running = false;
  }
}

window.addEventListener(
  "keydown",
  (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void runSnippet();
      return;
    }

    if (event.key === "F6") {
      event.preventDefault();
      event.stopPropagation();
      if (document.activeElement === outputElement) {
        view.focus();
      } else {
        outputElement.focus();
      }
    }
  },
  true,
);
