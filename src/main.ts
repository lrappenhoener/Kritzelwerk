import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getVersion } from "@tauri-apps/api/app";
import { basicSetup } from "codemirror";
import {
  Compartment,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutter } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { rust } from "@codemirror/lang-rust";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { vim, getCM } from "@replit/codemirror-vim";
import { undo, redo, selectAll } from "@codemirror/commands";
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  moveCompletionSelection,
  startCompletion,
} from "@codemirror/autocomplete";
import { LSPClient, serverCompletion } from "@codemirror/lsp-client";
import {
  diagnosticCount,
  nextDiagnostic,
  setDiagnostics,
} from "@codemirror/lint";
import type { Diagnostic as EditorDiagnostic } from "@codemirror/lint";

type SnippetStatus = "success" | "build_error" | "run_error" | "timeout";

interface SnippetRange {
  /** UTF-16-Offsets, wie von CodeMirror erwartet. */
  from: number;
  to: number;
}

interface SnippetDiagnostic {
  message: string;
  severity: "error" | "warning";
  code: string | null;
  range: SnippetRange | null;
  rendered: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

interface JsonObject {
  [key: string]: JsonValue;
}

interface SnippetResult {
  status: SnippetStatus;
  stdout: string;
  stderr: string;
  diagnostics: SnippetDiagnostic[];
  exit_code: number | null;
  values: JsonValue[];
}

interface RunRecord {
  id: string;
  started_at: number;
  duration_ms: number;
  status: SnippetStatus;
  language: SnippetLanguage;
  mode: ExecutionMode;
  source: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  diagnostics: SnippetDiagnostic[];
  values: JsonValue[];
}

interface AiProfile {
  id: string;
  name: string;
  base_url: string;
  model: string;
  personal: boolean;
  protocol: string;
  key_env: string | null;
  key_required: boolean;
}

interface AiProfiles {
  profiles: AiProfile[];
  config_error: string | null;
}

interface AiAnswer {
  text: string;
}

interface TreeRow {
  path: string;
  depth: number;
  label: string | null;
  value: JsonValue;
  expandable: boolean;
  expanded: boolean;
}

type ThemeId = "mocha" | "latte";

const THEME_STORAGE_KEY = "kritzelwerk.theme";
const THEMES: { id: ThemeId; name: string }[] = [
  { id: "mocha", name: "Catppuccin Mocha" },
  { id: "latte", name: "Catppuccin Latte" },
];

type LeaderActionId =
  | "open-snippet"
  | "new-snippet"
  | "save-snippet"
  | "run"
  | "assistant"
  | "theme-picker"
  | "shortcuts"
  | "debug-toggle-breakpoint"
  | "debug-continue"
  | "debug-next"
  | "debug-stop"
  | "zen-toggle";

interface LeaderConfig {
  leader: string;
  mappings: Record<LeaderActionId, string[]>;
}

const LEADER_STORAGE_KEY = "kritzelwerk.leader";
const LEADER_ACTIONS: { id: LeaderActionId; label: string }[] = [
  { id: "open-snippet", label: "Öffnen" },
  { id: "new-snippet", label: "Neu" },
  { id: "save-snippet", label: "Speichern" },
  { id: "run", label: "Ausführen" },
  { id: "assistant", label: "KI-Seitenleiste" },
  { id: "theme-picker", label: "Theme-Auswahl" },
  { id: "shortcuts", label: "Tastenkürzel" },
  { id: "debug-toggle-breakpoint", label: "Haltepunkt umschalten" },
  { id: "debug-continue", label: "Debuggen/Weiter" },
  { id: "debug-next", label: "Nächster Schritt" },
  { id: "debug-stop", label: "Debug stoppen" },
  { id: "zen-toggle", label: "Zen-Modus" },
];

const DEFAULT_LEADER_CONFIG: LeaderConfig = {
  leader: " ",
  mappings: {
    "open-snippet": ["f", "f"],
    "new-snippet": ["f", "n"],
    "save-snippet": ["f", "s"],
    run: ["r"],
    assistant: ["a"],
    "theme-picker": ["t"],
    shortcuts: ["?"],
    "debug-toggle-breakpoint": ["d", "b"],
    "debug-continue": ["d", "c"],
    "debug-next": ["d", "n"],
    "debug-stop": ["d", "q"],
    "zen-toggle": ["z"],
  },
};

const LEADER_GROUP_LABELS: Record<string, string> = {
  f: "Datei",
  d: "Debug",
};

const NON_RUST_LEADER_ACTIONS = new Set<LeaderActionId>([
  "open-snippet",
  "new-snippet",
  "save-snippet",
  "run",
  "assistant",
  "theme-picker",
  "shortcuts",
  "zen-toggle",
]);

function cloneLeaderConfig(config: LeaderConfig): LeaderConfig {
  const mappings = {} as Record<LeaderActionId, string[]>;
  for (const action of LEADER_ACTIONS) {
    mappings[action.id] = [...config.mappings[action.id]];
  }
  return { leader: config.leader, mappings };
}

function leaderActionLabel(id: LeaderActionId): string {
  return LEADER_ACTIONS.find((action) => action.id === id)?.label ?? id;
}

function leaderKeyLabel(key: string): string {
  return key === " " ? "Leertaste" : key;
}

function leaderSequenceLabel(sequence: string[]): string {
  if (sequence.length === 0) {
    return "nicht belegt";
  }
  return leaderKeyLabel(currentLeaderConfig.leader) +
    ` ${sequence.map(leaderKeyLabel).join(" ")}`;
}

function isPrintableLeaderKey(value: string): boolean {
  return (
    Array.from(value).length === 1 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function parseLeaderInput(raw: string): string | null {
  if (raw === " " || /^leertaste$/i.test(raw.trim())) {
    return " ";
  }
  const value = raw.trim();
  if (!isPrintableLeaderKey(value) || /\s/.test(value)) {
    return null;
  }
  return value;
}

function parseLeaderSequence(raw: string): {
  sequence?: string[];
  error?: string;
} {
  const value = raw.trim();
  if (!value) {
    return { sequence: [] };
  }
  const parts = value.split(/\s+/);
  if (parts.length < 1 || parts.length > 3) {
    return { error: "Folgen bestehen aus 1 bis 3 Zeichen." };
  }
  for (const part of parts) {
    if (
      Array.from(part).length !== 1 ||
      /\s/.test(part) ||
      /[\u0000-\u001f\u007f]/.test(part)
    ) {
      return {
        error: "Jedes Folgenzeichen muss ein einzelnes druckbares Zeichen sein.",
      };
    }
  }
  return { sequence: parts };
}

function sequencesConflict(left: string[], right: string[]): boolean {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

interface LeaderValidation {
  config: LeaderConfig | null;
  leaderError: string | null;
  actionErrors: Record<LeaderActionId, string | null>;
}

function validateLeaderConfiguration(
  leaderRaw: string,
  values: Record<LeaderActionId, string>,
): LeaderValidation {
  const leader = parseLeaderInput(leaderRaw);
  const leaderError = leader
    ? null
    : "Leader muss die Leertaste oder ein einzelnes druckbares Zeichen sein.";
  const actionErrors = {} as Record<LeaderActionId, string | null>;
  const parsed = {} as Record<LeaderActionId, string[] | null>;
  const mappings = {} as Record<LeaderActionId, string[]>;

  for (const action of LEADER_ACTIONS) {
    const result = parseLeaderSequence(values[action.id] ?? "");
    if (result.error || !result.sequence) {
      actionErrors[action.id] = result.error ?? "Ungültige Folge.";
      parsed[action.id] = null;
    } else {
      actionErrors[action.id] = null;
      parsed[action.id] = result.sequence;
      mappings[action.id] = result.sequence;
    }
  }

  for (let leftIndex = 0; leftIndex < LEADER_ACTIONS.length; leftIndex += 1) {
    const leftAction = LEADER_ACTIONS[leftIndex];
    const leftSequence = parsed[leftAction.id];
    if (!leftSequence || leftSequence.length === 0) {
      continue;
    }
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < LEADER_ACTIONS.length;
      rightIndex += 1
    ) {
      const rightAction = LEADER_ACTIONS[rightIndex];
      const rightSequence = parsed[rightAction.id];
      if (!rightSequence || rightSequence.length === 0) {
        continue;
      }
      if (!sequencesConflict(leftSequence, rightSequence)) {
        continue;
      }
      const equal =
        leftSequence.length === rightSequence.length;
      const message = equal
        ? `Doppelte Folge mit „${leaderActionLabel(rightAction.id)}“.`
        : `Konflikt mit „${leaderActionLabel(rightAction.id)}“: Eine Folge ist Präfix der anderen.`;
      actionErrors[leftAction.id] = actionErrors[leftAction.id] ?? message;
      actionErrors[rightAction.id] = actionErrors[rightAction.id] ??
        (equal
          ? `Doppelte Folge mit „${leaderActionLabel(leftAction.id)}“.`
          : `Konflikt mit „${leaderActionLabel(leftAction.id)}“: Eine Folge ist Präfix der anderen.`);
    }
  }

  const valid =
    leader !== null &&
    LEADER_ACTIONS.every((action) => actionErrors[action.id] === null);
  return {
    config: valid && leader ? { leader, mappings } : null,
    leaderError,
    actionErrors,
  };
}

function storedLeaderConfig(): LeaderConfig {
  try {
    const raw = localStorage.getItem(LEADER_STORAGE_KEY);
    if (!raw) {
      return cloneLeaderConfig(DEFAULT_LEADER_CONFIG);
    }
    const parsed = JSON.parse(raw) as Partial<LeaderConfig>;
    const leader = typeof parsed.leader === "string" ? parsed.leader : "";
    const storedMappings = parsed.mappings as
      | Partial<Record<LeaderActionId, unknown>>
      | undefined;
    const present = new Set<LeaderActionId>();
    const values = {} as Record<LeaderActionId, string>;

    for (const action of LEADER_ACTIONS) {
      const value = storedMappings?.[action.id];
      if (Array.isArray(value)) {
        present.add(action.id);
        values[action.id] = value
          .filter((part): part is string => typeof part === "string")
          .join(" ");
      } else {
        values[action.id] = "";
      }
    }

    // Neue Aktionen mit ihren Standards ergänzen, ohne bestehende
    // Benutzerbelegungen zu überschreiben oder zu verdrängen.
    for (const action of LEADER_ACTIONS) {
      if (present.has(action.id)) {
        continue;
      }
      const fallback = DEFAULT_LEADER_CONFIG.mappings[action.id];
      const conflict = LEADER_ACTIONS.some((other) => {
        if (other.id === action.id) {
          return false;
        }
        const existing = parseLeaderSequence(values[other.id] ?? "").sequence;
        return Boolean(
          existing &&
            existing.length > 0 &&
            sequencesConflict(fallback, existing),
        );
      });
      if (!conflict) {
        values[action.id] = fallback.join(" ");
      }
    }

    const validation = validateLeaderConfiguration(leader, values);
    return validation.config
      ? cloneLeaderConfig(validation.config)
      : cloneLeaderConfig(DEFAULT_LEADER_CONFIG);
  } catch {
    return cloneLeaderConfig(DEFAULT_LEADER_CONFIG);
  }
}

let currentLeaderConfig: LeaderConfig = storedLeaderConfig();

function applyLeaderConfig(config: LeaderConfig) {
  currentLeaderConfig = cloneLeaderConfig(config);
  try {
    localStorage.setItem(
      LEADER_STORAGE_KEY,
      JSON.stringify(currentLeaderConfig),
    );
  } catch {
    // The configuration still applies for this session.
  }
  resetLeaderSequence();
}

interface LeaderNode {
  action: LeaderActionId | null;
  children: Map<string, LeaderNode>;
}

function buildLeaderTree(visualMode: boolean): LeaderNode {
  const root: LeaderNode = { action: null, children: new Map() };
  const actions = visualMode
    ? LEADER_ACTIONS.filter((action) => action.id === "assistant")
    : currentLanguage !== "rust"
      ? LEADER_ACTIONS.filter((action) => NON_RUST_LEADER_ACTIONS.has(action.id))
      : LEADER_ACTIONS;

  for (const action of actions) {
    const sequence = currentLeaderConfig.mappings[action.id];
    if (!sequence || sequence.length === 0) {
      continue;
    }
    let node = root;
    for (const key of sequence) {
      let child = node.children.get(key);
      if (!child) {
        child = { action: null, children: new Map() };
        node.children.set(key, child);
      }
      node = child;
    }
    node.action = action.id;
  }
  return root;
}

function leaderNodeAt(root: LeaderNode, prefix: string[]): LeaderNode | null {
  let node: LeaderNode | undefined = root;
  for (const key of prefix) {
    node = node.children.get(key);
    if (!node) {
      return null;
    }
  }
  return node;
}

function leaderNodeLabel(node: LeaderNode, prefix: string[]): string {
  if (node.action) {
    return leaderActionLabel(node.action);
  }
  const actions = new Set<LeaderActionId>();
  const collect = (current: LeaderNode) => {
    if (current.action) {
      actions.add(current.action);
    }
    for (const child of current.children.values()) {
      collect(child);
    }
  };
  collect(node);
  if (actions.size === 1) {
    return leaderActionLabel([...actions][0]);
  }
  const fileActions: LeaderActionId[] = [
    "open-snippet",
    "new-snippet",
    "save-snippet",
  ];
  if (fileActions.every((action) => actions.has(action))) {
    return "Datei";
  }
  return LEADER_GROUP_LABELS[prefix.join(" ")] ?? "…";
}

function storedTheme(): ThemeId {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "latte" || value === "mocha" ? value : "mocha";
  } catch {
    return "mocha";
  }
}

let currentTheme: ThemeId = storedTheme();
document.documentElement.dataset.theme = currentTheme;

type ZenWidth = "full" | "centered";
type FocusDimmingMode = "off" | "zen" | "always";

interface ZenSettings {
  showMenubar: boolean;
  showSnippetBar: boolean;
  showOutput: boolean;
  showAssistant: boolean;
  showVimStatus: boolean;
  width: ZenWidth;
  focusDimming: FocusDimmingMode;
  focusContextLines: number;
  focusStrength: number;
}

const ZEN_STORAGE_KEY = "kritzelwerk.zen";
const DEFAULT_ZEN_SETTINGS: ZenSettings = {
  showMenubar: false,
  showSnippetBar: false,
  showOutput: false,
  showAssistant: false,
  showVimStatus: true,
  width: "centered",
  focusDimming: "zen",
  focusContextLines: 5,
  focusStrength: 50,
};

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function storedZenSettings(): ZenSettings {
  try {
    const raw = localStorage.getItem(ZEN_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_ZEN_SETTINGS };
    }
    const parsed = JSON.parse(raw) as Partial<ZenSettings>;
    return {
      showMenubar:
        typeof parsed.showMenubar === "boolean"
          ? parsed.showMenubar
          : DEFAULT_ZEN_SETTINGS.showMenubar,
      showSnippetBar:
        typeof parsed.showSnippetBar === "boolean"
          ? parsed.showSnippetBar
          : DEFAULT_ZEN_SETTINGS.showSnippetBar,
      showOutput:
        typeof parsed.showOutput === "boolean"
          ? parsed.showOutput
          : DEFAULT_ZEN_SETTINGS.showOutput,
      showAssistant:
        typeof parsed.showAssistant === "boolean"
          ? parsed.showAssistant
          : DEFAULT_ZEN_SETTINGS.showAssistant,
      showVimStatus:
        typeof parsed.showVimStatus === "boolean"
          ? parsed.showVimStatus
          : DEFAULT_ZEN_SETTINGS.showVimStatus,
      width: parsed.width === "full" || parsed.width === "centered"
        ? parsed.width
        : DEFAULT_ZEN_SETTINGS.width,
      focusDimming:
        parsed.focusDimming === "off" ||
        parsed.focusDimming === "zen" ||
        parsed.focusDimming === "always"
          ? parsed.focusDimming
          : DEFAULT_ZEN_SETTINGS.focusDimming,
      focusContextLines: clampInteger(
        parsed.focusContextLines,
        DEFAULT_ZEN_SETTINGS.focusContextLines,
        0,
        100,
      ),
      focusStrength: clampInteger(
        parsed.focusStrength,
        DEFAULT_ZEN_SETTINGS.focusStrength,
        0,
        80,
      ),
    };
  } catch {
    return { ...DEFAULT_ZEN_SETTINGS };
  }
}

let currentZenSettings: ZenSettings = storedZenSettings();
let zenActive = false;
let zenOverrides: {
  menubar: boolean;
  output: boolean;
  assistant: boolean;
} = {
  menubar: false,
  output: false,
  assistant: false,
};

type DockSide = "left" | "right" | "bottom";
type DockPanelId = "output" | "assistant";

interface DockLayout {
  positions: Record<DockPanelId, DockSide>;
  sizes: Record<DockSide, number>;
  active: Record<DockSide, DockPanelId>;
}

const DOCK_STORAGE_KEY = "kritzelwerk.docks";
const DEFAULT_DOCK_LAYOUT: DockLayout = {
  positions: { output: "bottom", assistant: "right" },
  sizes: { left: 360, right: 360, bottom: 320 },
  active: { left: "output", right: "assistant", bottom: "output" },
};

const DOCK_SIDES: DockSide[] = ["left", "right", "bottom"];
const DOCK_PANELS: DockPanelId[] = ["output", "assistant"];

function cloneDockLayout(layout: DockLayout): DockLayout {
  return {
    positions: { ...layout.positions },
    sizes: { ...layout.sizes },
    active: { ...layout.active },
  };
}

function storedDockLayout(): DockLayout {
  try {
    const raw = localStorage.getItem(DOCK_STORAGE_KEY);
    if (!raw) {
      return cloneDockLayout(DEFAULT_DOCK_LAYOUT);
    }
    const parsed = JSON.parse(raw) as Partial<DockLayout>;
    const layout = cloneDockLayout(DEFAULT_DOCK_LAYOUT);
    for (const panel of DOCK_PANELS) {
      const side = parsed.positions?.[panel];
      if (side === "left" || side === "right" || side === "bottom") {
        layout.positions[panel] = side;
      }
    }
    for (const side of DOCK_SIDES) {
      layout.sizes[side] = clampInteger(
        parsed.sizes?.[side],
        DEFAULT_DOCK_LAYOUT.sizes[side],
        140,
        1200,
      );
      const active = parsed.active?.[side];
      if (active === "output" || active === "assistant") {
        layout.active[side] = active;
      }
    }
    return layout;
  } catch {
    return cloneDockLayout(DEFAULT_DOCK_LAYOUT);
  }
}

let currentDockLayout: DockLayout = storedDockLayout();

const themeCompartment = new Compartment();
const lspCompartment = new Compartment();
const languageCompartment = new Compartment();
const readOnlyCompartment = new Compartment();

const setBreakpointLinesEffect = StateEffect.define<Map<number, boolean>>();
const breakpointField = StateField.define<Map<number, boolean>>({
  create: () => new Map(),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setBreakpointLinesEffect)) {
        return new Map(effect.value);
      }
    }
    return value;
  },
});

class BreakpointGutterMarker extends GutterMarker {
  constructor(private readonly verified: boolean) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return (
      other instanceof BreakpointGutterMarker &&
      other.verified === this.verified
    );
  }

  toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = this.verified
      ? "cm-breakpoint-marker"
      : "cm-breakpoint-marker is-unverified";
    return element;
  }
}

const verifiedBreakpointMarker = new BreakpointGutterMarker(true);
const unverifiedBreakpointMarker = new BreakpointGutterMarker(false);

const breakpointGutter = gutter({
  class: "cm-breakpoint-gutter",
  markers(view) {
    const builder = new RangeSetBuilder<GutterMarker>();
    const breakpoints = view.state.field(breakpointField);
    const lines = [...breakpoints.entries()].sort(
      (left, right) => left[0] - right[0],
    );
    for (const [lineNumber, verified] of lines) {
      if (lineNumber < 1 || lineNumber > view.state.doc.lines) {
        continue;
      }
      const line = view.state.doc.line(lineNumber);
      builder.add(
        line.from,
        line.from,
        verified ? verifiedBreakpointMarker : unverifiedBreakpointMarker,
      );
    }
    return builder.finish();
  },
  domEventHandlers: {
    mousedown(view, block) {
      toggleBreakpointAtLine(view.state.doc.lineAt(block.from).number);
      return true;
    },
  },
});

const setDebugLineEffect = StateEffect.define<number | null>();
const debugLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setDebugLineEffect)) {
        const lineNumber = effect.value;
        if (
          lineNumber === null ||
          lineNumber < 1 ||
          lineNumber > transaction.state.doc.lines
        ) {
          return Decoration.none;
        }
        const line = transaction.state.doc.line(lineNumber);
        return Decoration.set([
          Decoration.line({ class: "cm-debug-current-line" }).range(line.from),
        ]);
      }
    }
    return decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

const setFocusDimmingEffect = StateEffect.define<DecorationSet>();
const focusDimmingField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setFocusDimmingEffect)) {
        return effect.value;
      }
    }
    return decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

let lspClient: LSPClient | null = null;
let lspReady = false;
let lspStarting = false;
let lspHintTimer: number | undefined;
let lspGeneration = 0;
let lspListeners: Promise<void> | null = null;
const lspHandlers = new Set<(value: string) => void>();

function editorTheme(theme: ThemeId) {
  return [
    EditorView.theme(
      {
        "&": {
          color: "var(--fg)",
          backgroundColor: "var(--bg)",
        },
        ".cm-content": {
          caretColor: "var(--cursor)",
        },
        ".cm-cursor, .cm-dropCursor": {
          borderLeftColor: "var(--cursor)",
        },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
          {
            backgroundColor: "var(--selection)",
          },
        ".cm-gutters": {
          backgroundColor: "var(--mantle)",
          color: "var(--muted)",
          borderRight: "1px solid var(--border)",
        },
        ".cm-activeLine": {
          backgroundColor: "var(--active-line)",
        },
        ".cm-activeLineGutter": {
          backgroundColor: "var(--surface0)",
          color: "var(--fg)",
        },
        ".cm-selectionMatch": {
          backgroundColor: "var(--selection-soft)",
        },
        ".cm-searchMatch": {
          backgroundColor: "var(--selection-soft)",
        },
        ".cm-searchMatch.cm-searchMatch-selected": {
          backgroundColor: "var(--selection)",
        },
        ".cm-panels": {
          backgroundColor: "var(--mantle)",
          color: "var(--fg)",
        },
        ".cm-panels.cm-panels-top": {
          borderBottom: "1px solid var(--border)",
        },
        ".cm-tooltip": {
          backgroundColor: "var(--mantle)",
          color: "var(--fg)",
          border: "1px solid var(--border)",
        },
        ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
          backgroundColor: "var(--selection)",
          color: "var(--fg)",
        },
        ".cm-lintRange-error": {
          backgroundImage: "none",
          textDecoration: "underline wavy var(--error)",
        },
        ".cm-lintRange-warning": {
          backgroundImage: "none",
          textDecoration: "underline wavy var(--warning)",
        },
        ".cm-lintRange-info": {
          backgroundImage: "none",
          textDecoration: "underline wavy var(--accent)",
        },
        ".cm-lintRange-active": {
          backgroundColor: "var(--selection-soft)",
        },
        ".cm-fat-cursor": {
          backgroundColor: "var(--cursor)",
          color: "var(--bg)",
        },
        ".cm-matchingBracket": {
          backgroundColor: "var(--selection)",
          outline: "1px solid var(--accent)",
        },
        ".cm-foldPlaceholder": {
          backgroundColor: "var(--surface0)",
          border: "1px solid var(--border)",
          color: "var(--subtext)",
        },
      },
      { dark: theme === "mocha" },
    ),
    syntaxHighlighting(
      HighlightStyle.define([
        {
          tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword],
          color: "var(--syntax-keyword)",
        },
        {
          tag: [tags.typeName, tags.className, tags.namespace],
          color: "var(--syntax-type)",
        },
        {
          tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
          color: "var(--syntax-function)",
        },
        {
          tag: [tags.string, tags.special(tags.string), tags.regexp],
          color: "var(--syntax-string)",
        },
        {
          tag: [tags.number, tags.bool, tags.null, tags.atom],
          color: "var(--syntax-number)",
        },
        {
          tag: [tags.comment, tags.lineComment, tags.blockComment],
          color: "var(--syntax-comment)",
          fontStyle: "italic",
        },
        {
          tag: [tags.variableName, tags.propertyName],
          color: "var(--fg)",
        },
        {
          tag: [tags.operator, tags.punctuation, tags.bracket],
          color: "var(--subtext)",
        },
        {
          tag: [tags.macroName, tags.meta],
          color: "var(--syntax-macro)",
        },
        {
          tag: [tags.annotation, tags.processingInstruction],
          color: "var(--syntax-meta)",
        },
        {
          tag: tags.invalid,
          color: "var(--error)",
        },
        {
          tag: tags.emphasis,
          fontStyle: "italic",
        },
        {
          tag: tags.strong,
          fontWeight: "bold",
        },
      ]),
    ),
  ];
}

interface SnippetInfo {
  name: string;
  language: SnippetLanguage;
}

type SnippetLanguage = "rust" | "java" | "javascript";

interface SnippetDocument {
  contents: string;
  mode: ExecutionMode;
  language: SnippetLanguage;
}

type ExecutionMode = "expression" | "statements" | "program";

const EXECUTION_MODES: {
  id: ExecutionMode;
  name: string;
  hint: string;
}[] = [
  {
    id: "expression",
    name: "Ausdruck",
    hint: "Wertet einen Ausdruck aus und zeigt das Ergebnis automatisch über dump().",
  },
  {
    id: "statements",
    name: "Anweisungen",
    hint: "Führt die Anweisungen in einem generierten fn main() aus.",
  },
  {
    id: "program",
    name: "Programm",
    hint: "Führt ein vollständiges Rust-Programm mit fn main() aus.",
  },
];

function modeName(mode: ExecutionMode): string {
  return EXECUTION_MODES.find((entry) => entry.id === mode)?.name ?? mode;
}

function normalizeExecutionMode(raw: string): ExecutionMode {
  return raw === "expression" || raw === "statements" || raw === "program"
    ? raw
    : "program";
}

interface SaveResult {
  status: "saved" | "exists";
  name: string;
}

interface ExportResult {
  path: string;
}

interface ProjectExportResult {
  path: string;
  locked: boolean;
}

interface SharedDependency {
  name: string;
  version: string;
  features: string[];
}

interface ImportPreview {
  version: number;
  name: string;
  mode: string;
  dependencies: SharedDependency[];
  has_lockfile: boolean;
  name_taken: boolean;
}

interface ImportResult {
  name: string;
}

interface DebugBreakpointState {
  line: number;
  verified: boolean;
}

interface DebugStartResult {
  started: boolean;
  diagnostics: SnippetDiagnostic[];
  stderr: string;
  message: string | null;
  breakpoints: DebugBreakpointState[];
}

interface DebugVariable {
  name: string;
  type: string | null;
  value: string;
}

interface DebugSnapshot {
  line: number | null;
  frame: string | null;
  variables: DebugVariable[];
}

interface DebugEvent {
  event: string;
  thread_id: number | null;
  reason: string | null;
  output: string | null;
  category: string | null;
  exit_code: number | null;
}

interface CargoDependency {
  name: string;
  version: string;
  features: string[];
  resolved: string | null;
}

interface CargoDependencyConfig {
  snippet: string;
  dependencies: CargoDependency[];
}

const NEW_SNIPPET = `vec!["Eisen", "Kupfer"]
`;

const NEW_JAVA_SNIPPET = `public class Main {
    public static void main(String[] args) {
        System.out.println("Hallo, Kritzelwerk!");
    }
}
`;

const NEW_JAVASCRIPT_SNIPPET = `const funde = [0, 3, 0, 7].filter(menge => menge > 0);
console.log(JSON.stringify(funde));
`;

function languageLabel(language: SnippetLanguage): string {
  return language === "java"
    ? "Java"
    : language === "javascript"
      ? "JavaScript"
      : "Rust";
}

function languageExtension(language: SnippetLanguage): string {
  return language === "java"
    ? "java"
    : language === "javascript"
      ? "mjs"
      : "rs";
}

function editorLanguage(language: SnippetLanguage) {
  return language === "java"
    ? java()
    : language === "javascript"
      ? javascript()
      : rust();
}

function normalizeLanguage(raw: string): SnippetLanguage {
  return raw === "java" || raw === "javascript" ? raw : "rust";
}

const snippetNameElement = document.querySelector(
  "#snippet-name",
) as HTMLElement;
const snippetBarElement = document.querySelector("#snippet-bar") as HTMLElement;
const snippetLanguageElement = document.querySelector(
  "#snippet-language",
) as HTMLElement;
const snippetModeElement = document.querySelector(
  "#snippet-mode",
) as HTMLElement;
const snippetDirtyElement = document.querySelector(
  "#snippet-dirty",
) as HTMLElement;
const lspHintElement = document.querySelector("#lsp-hint") as HTMLElement;
const whichKeyElement = document.querySelector("#which-key") as HTMLElement;
const modalRoot = document.querySelector("#modal-root") as HTMLElement;
const menubarElement = document.querySelector("#menubar") as HTMLElement;
const menuButtons = Array.from(
  menubarElement.querySelectorAll<HTMLButtonElement>(".menu-button"),
);
const zoomOutButton = document.querySelector(
  "#zoom-out",
) as HTMLButtonElement;
const zoomValueButton = document.querySelector(
  "#zoom-value",
) as HTMLButtonElement;
const zoomInButton = document.querySelector("#zoom-in") as HTMLButtonElement;

let currentSnippetName: string | null = null;
let lastSavedContent: string | null = null;
let currentMode: ExecutionMode = "program";
let lastSavedMode: ExecutionMode | null = "program";
let currentLanguage: SnippetLanguage = "rust";

const ZOOM_STORAGE_KEY = "kritzelwerk.zoom";

function storedZoomPercent(): number {
  try {
    const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
    const value = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    if (
      Number.isFinite(value) &&
      value >= 80 &&
      value <= 200 &&
      value % 10 === 0
    ) {
      return value;
    }
  } catch {
    // Fall back to 100%.
  }
  return 100;
}

let zoomPercent = storedZoomPercent();
let zoomTarget = zoomPercent;
let openMenuElement: HTMLElement | null = null;
let menuRestoreFocus: HTMLElement | EditorView | null = null;

const example = `use scratchpad::dump;

#[derive(serde::Serialize)]
struct Erzfund {
    erzart: &'static str,
    menge: u32,
}

#[derive(serde::Serialize)]
struct Stollen {
    name: &'static str,
    tiefe: u32,
    funde: Vec<Erzfund>,
}

fn main() {
    let funde: Vec<Erzfund> = [
        Erzfund { erzart: "Eisen", menge: 0 },
        Erzfund { erzart: "Gold", menge: 3 },
        Erzfund { erzart: "Silber", menge: 0 },
        Erzfund { erzart: "Kupfer", menge: 7 },
    ]
    .into_iter()
    .filter(|fund| fund.menge > 0)
    .collect();

    let anzahl = funde.len();
    dump(&funde);
    dump(&Stollen { name: "Nordstollen", tiefe: 42, funde });
    println!("{anzahl} Funde");
}
`;

lastSavedContent = example;

const editorElement = document.querySelector("#editor") as HTMLElement;
const outputElement = document.querySelector("#output") as HTMLElement;
const outputTextElement = document.querySelector("#output-text") as HTMLElement;
const outputValuesElement = document.querySelector(
  "#output-values",
) as HTMLElement;

const debugViewElement = document.querySelector("#debug-view") as HTMLElement;
const debugStatusElement = document.querySelector(
  "#debug-status",
) as HTMLElement;
const debugLocalsElement = document.querySelector(
  "#debug-locals",
) as HTMLElement;
const debugOutputElement = document.querySelector(
  "#debug-output",
) as HTMLElement;

const assistantElement = document.querySelector("#assistant") as HTMLElement;
const assistantQuestion = document.querySelector(
  "#assistant-question",
) as HTMLTextAreaElement;
const assistantSend = document.querySelector(
  "#assistant-send",
) as HTMLButtonElement;
const assistantStatus = document.querySelector(
  "#assistant-status",
) as HTMLElement;
const assistantAnswer = document.querySelector(
  "#assistant-answer",
) as HTMLElement;
const assistantSettings = document.querySelector(
  "#assistant-settings",
) as HTMLButtonElement;
const assistantConfigHint = document.querySelector(
  "#assistant-config-hint",
) as HTMLElement;

const dockLeftElement = document.querySelector("#dock-left") as HTMLElement;
const dockRightElement = document.querySelector("#dock-right") as HTMLElement;
const dockBottomElement = document.querySelector("#dock-bottom") as HTMLElement;
const outputPanelElement = document.querySelector(
  "#output-panel",
) as HTMLElement;
const outputBannerElement = document.querySelector(
  "#output-banner",
) as HTMLElement;
const outputBannerText = document.querySelector(
  "#output-banner-text",
) as HTMLElement;
const outputReturnButton = document.querySelector(
  "#output-return",
) as HTMLButtonElement;
const dockTargetsElement = document.querySelector(
  "#dock-targets",
) as HTMLElement;

const updateListener = EditorView.updateListener.of((update) => {
  if (update.docChanged) {
    queueMicrotask(clearDiagnostics);
    updateSnippetTitle();
  }
  if (update.docChanged || update.selectionSet || update.viewportChanged) {
    scheduleFocusDimming();
  }
});


function buildExtensions() {
  return [
    vim({ status: true }),
    basicSetup,
    languageCompartment.of(editorLanguage(currentLanguage)),
    EditorView.lineWrapping,
    autocompletion({ activateOnTyping: false }),
    breakpointField,
    breakpointGutter,
    debugLineField,
    focusDimmingField,
    readOnlyCompartment.of(EditorState.readOnly.of(false)),
    themeCompartment.of(editorTheme(currentTheme)),
    lspCompartment.of([]),
    updateListener,
  ];
}

const view = new EditorView({
  doc: example,
  extensions: buildExtensions(),
  parent: editorElement,
});

view.focus();
updateSnippetTitle();

let running = false;

function clearDiagnostics() {
  if (diagnosticCount(view.state) > 0) {
    view.dispatch(setDiagnostics(view.state, []));
  }
}

function toEditorDiagnostics(
  diagnostics: SnippetDiagnostic[],
): EditorDiagnostic[] {
  return diagnostics.flatMap((diagnostic) => {
    if (!diagnostic.range) {
      return [];
    }
    const message = diagnostic.code
      ? `${diagnostic.message} (${diagnostic.code})`
      : diagnostic.message;
    return [
      {
        from: diagnostic.range.from,
        to: diagnostic.range.to,
        severity: diagnostic.severity,
        message,
        source: diagnostic.code ?? undefined,
      },
    ];
  });
}

function renderedDiagnostics(result: SnippetResult): string {
  return result.diagnostics
    .map((diagnostic) => diagnostic.rendered)
    .filter((rendered) => rendered.length > 0)
    .join("\n\n");
}

function renderResult(result: SnippetResult): string {
  const rendered = renderedDiagnostics(result);

  if (result.status === "build_error") {
    return rendered || result.stderr || "Build fehlgeschlagen.";
  }

  const parts: string[] = [];

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
  if (rendered) {
    parts.push(rendered);
  }
  if (parts.length === 0 && result.values.length === 0) {
    parts.push("(keine Ausgabe)");
  }

  return parts.join("\n\n");
}

function setOutput(text: string) {
  outputTextElement.textContent = text;
  syncTextVisibility();
}

function syncTextVisibility() {
  const hasText = (outputTextElement.textContent ?? "").trim().length > 0;
  const hasValues = outputValuesElement.childElementCount > 0;
  outputTextElement.hidden = !hasText && hasValues;
}

interface OutputSnapshot {
  text: string;
  values: JsonValue[];
}

let currentOutput: OutputSnapshot = { text: "", values: [] };
let historicalRun: RunRecord | null = null;

const RUN_STATUS_LABELS: Record<SnippetStatus, string> = {
  success: "Erfolg",
  build_error: "Build-Fehler",
  run_error: "Laufzeitfehler",
  timeout: "Zeitüberschreitung",
};

function runStatusLabel(status: SnippetStatus): string {
  return RUN_STATUS_LABELS[status] ?? status;
}

function formatRunTime(startedAt: number): string {
  const date = new Date(startedAt);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRunDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }
  const seconds = durationMs / 1000;
  const digits = seconds < 10 ? 1 : 0;
  return `${seconds.toFixed(digits).replace(".", ",")} s`;
}

function hideHistoryBanner() {
  historicalRun = null;
  outputBannerElement.hidden = true;
}

function renderCurrentOutput(text: string, values: JsonValue[]) {
  hideHistoryBanner();
  currentOutput = { text, values };
  setOutput(text);
  renderValues(values);
}

function renderHistoricalRun(run: RunRecord) {
  historicalRun = run;
  outputBannerText.textContent = `Historischer Lauf · ${formatRunTime(run.started_at)} · ${formatRunDuration(run.duration_ms)} · ${runStatusLabel(run.status)}`;
  outputBannerElement.hidden = false;
  setOutput(renderResult(run));
  renderValues(run.values);
  openOutputPanel(true);
}

function returnToCurrentOutput() {
  if (historicalRun === null && outputBannerElement.hidden) {
    return;
  }
  hideHistoryBanner();
  setOutput(currentOutput.text);
  renderValues(currentOutput.values);
  focusOutput();
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalarText(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

function valueSummary(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.length}]`;
  }
  if (isJsonObject(value)) {
    return `{${Object.keys(value).length}}`;
  }
  return scalarText(value);
}

function tableFrom(
  value: JsonValue,
): { columns: string[]; rows: JsonObject[] } | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  if (!value.every(isJsonObject)) {
    return null;
  }
  const rows = value as JsonObject[];
  const columns = Object.keys(rows[0]);
  if (columns.length === 0) {
    return null;
  }
  const signature = [...columns].sort().join("\u001f");
  for (const row of rows) {
    if ([...Object.keys(row)].sort().join("\u001f") !== signature) {
      return null;
    }
  }
  return { columns, rows };
}

function renderValues(values: JsonValue[]) {
  outputValuesElement.replaceChildren();
  values.forEach((value, index) => {
    const table = tableFrom(value);
    const element = table ? createTableView(table) : createTreeView(value);
    element.setAttribute("aria-label", `Strukturierte Ausgabe ${index + 1}`);
    outputValuesElement.append(element);
  });
  syncTextVisibility();
}

function createTableView(data: {
  columns: string[];
  rows: JsonObject[];
}): HTMLElement {
  const container = document.createElement("div");
  container.className = "value-view value-table";
  container.tabIndex = 0;

  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const column of data.columns) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = column;
    headRow.append(cell);
  }
  head.append(headRow);
  table.append(head);

  const body = document.createElement("tbody");
  const cells: HTMLTableCellElement[][] = [];

  data.rows.forEach((row) => {
    const tr = document.createElement("tr");
    const rowCells: HTMLTableCellElement[] = [];
    data.columns.forEach((column) => {
      const td = document.createElement("td");
      const value = row[column];
      if (isJsonObject(value) || Array.isArray(value)) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "cell-toggle";
        toggle.tabIndex = -1;
        toggle.textContent = valueSummary(value);
        toggle.setAttribute("aria-expanded", "false");

        const detail = document.createElement("pre");
        detail.className = "cell-detail";
        detail.textContent = JSON.stringify(value, null, 2);

        toggle.addEventListener("click", () => {
          const expanded = td.classList.toggle("expanded");
          toggle.setAttribute("aria-expanded", String(expanded));
        });

        td.append(toggle, detail);
      } else {
        td.textContent = scalarText(value);
      }
      tr.append(td);
      rowCells.push(td);
    });
    cells.push(rowCells);
    body.append(tr);
  });
  table.append(body);
  container.append(table);

  let activeRow = 0;
  let activeCol = 0;

  const setActive = (scroll: boolean) => {
    container
      .querySelectorAll("td.is-active")
      .forEach((cell) => cell.classList.remove("is-active"));
    const td = cells[activeRow]?.[activeCol];
    if (!td) {
      return;
    }
    td.classList.add("is-active");
    if (scroll) {
      td.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };

  cells.forEach((rowCells, rowIndex) => {
    rowCells.forEach((td, colIndex) => {
      td.addEventListener("click", () => {
        activeRow = rowIndex;
        activeCol = colIndex;
        setActive(false);
        container.focus();
      });
    });
  });

  container.addEventListener("keydown", (event) => {
    if (event.target instanceof Element && event.target.closest(".cell-toggle")) {
      return;
    }

    switch (event.key) {
      case "ArrowUp":
        activeRow = Math.max(0, activeRow - 1);
        break;
      case "ArrowDown":
        activeRow = Math.min(cells.length - 1, activeRow + 1);
        break;
      case "ArrowLeft":
        activeCol = Math.max(0, activeCol - 1);
        break;
      case "ArrowRight":
        activeCol = Math.min(data.columns.length - 1, activeCol + 1);
        break;
      case "Enter": {
        const toggle = cells[activeRow]?.[activeCol]?.querySelector<HTMLButtonElement>(
          ".cell-toggle",
        );
        if (!toggle) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        toggle.click();
        return;
      }
      default:
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    setActive(true);
  });

  container.addEventListener("focus", () => setActive(false));
  setActive(false);

  return container;
}

function collectTreeRows(root: JsonValue, expanded: Set<string>): TreeRow[] {
  const rows: TreeRow[] = [];

  const visit = (
    value: JsonValue,
    path: string,
    depth: number,
    label: string | null,
  ) => {
    const object = isJsonObject(value);
    const array = Array.isArray(value);
    const size = object
      ? Object.keys(value).length
      : array
        ? value.length
        : 0;
    const expandable = (object || array) && size > 0;
    const isExpanded = expandable && expanded.has(path);
    rows.push({ path, depth, label, value, expandable, expanded: isExpanded });
    if (!isExpanded) {
      return;
    }
    if (array) {
      value.forEach((child, index) => {
        visit(child, `${path}/${index}`, depth + 1, `[${index}]`);
      });
    } else if (object) {
      Object.entries(value).forEach(([key, child]) => {
        visit(child, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, depth + 1, key);
      });
    }
  };

  visit(root, "", 0, null);
  return rows;
}

function parentPath(path: string): string | null {
  const separator = path.lastIndexOf("/");
  if (path === "") {
    return null;
  }
  return separator === -1 ? "" : path.slice(0, separator);
}

function createTreeView(root: JsonValue): HTMLElement {
  const container = document.createElement("div");
  container.className = "value-view value-tree";
  container.tabIndex = 0;

  const list = document.createElement("div");
  list.className = "tree-rows";
  container.append(list);

  const expanded = new Set<string>([""]);
  let selected = "";

  const toggle = (path: string) => {
    if (expanded.has(path)) {
      expanded.delete(path);
    } else {
      expanded.add(path);
    }
    selected = path;
    render();
  };

  const render = () => {
    const rows = collectTreeRows(root, expanded);
    list.replaceChildren();

    for (const row of rows) {
      const rowElement = document.createElement("div");
      rowElement.className = "tree-row";
      if (row.path === selected) {
        rowElement.classList.add("is-active");
      }
      rowElement.style.paddingLeft = `${8 + row.depth * 18}px`;

      const marker = document.createElement("span");
      marker.className = "tree-toggle";
      marker.textContent = row.expandable ? (row.expanded ? "▾" : "▸") : " ";
      marker.addEventListener("click", (event) => {
        event.stopPropagation();
        if (row.expandable) {
          toggle(row.path);
        }
      });

      rowElement.append(marker);

      if (row.label !== null) {
        const label = document.createElement("span");
        label.className = "tree-key";
        label.textContent = `${row.label}: `;
        rowElement.append(label);
      }

      const value = document.createElement("span");
      value.className = "tree-value";
      if (row.expandable) {
        value.textContent = valueSummary(row.value);
      } else if (isJsonObject(row.value)) {
        value.textContent = "{}";
      } else if (Array.isArray(row.value)) {
        value.textContent = "[]";
      } else {
        value.textContent = scalarText(row.value);
        if (typeof row.value === "string") {
          value.classList.add("is-string");
        }
      }
      rowElement.append(value);

      rowElement.addEventListener("click", () => {
        selected = row.path;
        render();
      });

      list.append(rowElement);
    }

    const active = list.querySelector(".tree-row.is-active");
    active?.scrollIntoView({ block: "nearest" });
  };

  container.addEventListener("keydown", (event) => {
    const rows = collectTreeRows(root, expanded);
    const index = rows.findIndex((row) => row.path === selected);
    const row = rows[index];

    switch (event.key) {
      case "ArrowDown":
        selected = rows[Math.min(rows.length - 1, index + 1)]?.path ?? selected;
        break;
      case "ArrowUp":
        selected = rows[Math.max(0, index - 1)]?.path ?? selected;
        break;
      case "ArrowRight":
        if (row?.expandable && !row.expanded) {
          expanded.add(row.path);
        } else {
          return;
        }
        break;
      case "ArrowLeft":
        if (row?.expanded) {
          expanded.delete(row.path);
        } else {
          const parent = parentPath(row?.path ?? selected);
          if (parent === null) {
            return;
          }
          selected = parent;
        }
        break;
      default:
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    render();
  });

  render();
  return container;
}

let assistantProfiles: AiProfile[] = [];
let aiConfigError: string | null = null;
let asking = false;

const AI_SETTINGS_KEY = "kritzelwerk.ai";

interface AiSettings {
  profileId: string | null;
  model: string;
}

interface PendingSelection {
  snippetKey: string;
  snapshot: string;
  startLine: number;
  endLine: number;
  text: string;
}

function storedAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(AI_SETTINGS_KEY);
    if (!raw) {
      return { profileId: null, model: "" };
    }
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    return {
      profileId:
        typeof parsed.profileId === "string" && parsed.profileId
          ? parsed.profileId
          : null,
      model: typeof parsed.model === "string" ? parsed.model : "",
    };
  } catch {
    return { profileId: null, model: "" };
  }
}

let aiSettings = storedAiSettings();
let pendingSelection: PendingSelection | null = null;

function persistAiSettings() {
  try {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(aiSettings));
  } catch {
    // The settings still apply for this session.
  }
}

function snippetContextKey(): string {
  return `${currentLanguage}:${currentSnippetName ?? "__unbenannt__"}`;
}

function setAssistantStatus(text: string, kind?: "error" | "loading") {
  assistantStatus.textContent = text;
  assistantStatus.className = "";
  if (kind) {
    assistantStatus.classList.add(`is-${kind}`);
  }
}

function currentProfile(): AiProfile | null {
  if (aiSettings.profileId === null) {
    return null;
  }
  return (
    assistantProfiles.find((profile) => profile.id === aiSettings.profileId) ??
    null
  );
}

function effectiveModel(profile = currentProfile()): string {
  const stored = aiSettings.model.trim();
  return stored || profile?.model.trim() || "";
}

function updateAssistantConfigHint() {
  const configured =
    currentProfile() !== null && effectiveModel().length > 0;
  assistantConfigHint.hidden = configured;
  return configured;
}

function captureSelection() {
  const selection = view.state.selection.main;
  pendingSelection = null;
  if (selection.from === selection.to) {
    return;
  }

  const doc = view.state.doc;
  // Vim visual selections may end exactly at the start of the last marked
  // line, so that line must be included as well.
  const visual = Boolean(getCM(view)?.state.vim?.visualMode);
  const start = doc.lineAt(selection.from);
  const endPosition =
    !visual &&
    selection.to > selection.from &&
    doc.lineAt(selection.to).from === selection.to
      ? selection.to - 1
      : selection.to;
  const end = doc.lineAt(endPosition);
  pendingSelection = {
    snippetKey: snippetContextKey(),
    snapshot: doc.toString(),
    startLine: start.number,
    endLine: end.number,
    text: doc.sliceString(start.from, end.to),
  };
}

function validPendingSelection(code: string): PendingSelection | null {
  const selection = pendingSelection;
  if (
    !selection ||
    selection.snippetKey !== snippetContextKey() ||
    selection.snapshot !== code
  ) {
    pendingSelection = null;
    return null;
  }
  return selection;
}

function openAssistant() {
  if (zenActive && !currentZenSettings.showAssistant) {
    zenOverrides.assistant = true;
  }
  captureSelection();
  currentDockLayout.active[currentDockLayout.positions.assistant] = "assistant";
  renderDocks();
  updateAssistantConfigHint();
  assistantQuestion.focus();
}

function zenHidesMenubar(): boolean {
  return (
    zenActive &&
    !currentZenSettings.showMenubar &&
    !zenOverrides.menubar
  );
}

function zenHidesOutput(): boolean {
  return (
    zenActive &&
    !currentZenSettings.showOutput &&
    !zenOverrides.output
  );
}

const DOCK_LABELS: Record<DockPanelId, string> = {
  output: "Ausgabe",
  assistant: "KI",
};

function dockElement(side: DockSide): HTMLElement {
  return side === "left"
    ? dockLeftElement
    : side === "right"
      ? dockRightElement
      : dockBottomElement;
}

function dockPanelElement(panel: DockPanelId): HTMLElement {
  return panel === "output" ? outputPanelElement : assistantElement;
}

function dockPanelVisible(panel: DockPanelId): boolean {
  if (!zenActive) {
    return true;
  }
  if (panel === "output") {
    return currentZenSettings.showOutput || zenOverrides.output;
  }
  return currentZenSettings.showAssistant || zenOverrides.assistant;
}

function dockVisiblePanels(side: DockSide): DockPanelId[] {
  return DOCK_PANELS.filter(
    (panel) =>
      currentDockLayout.positions[panel] === side &&
      dockPanelVisible(panel),
  );
}

function dockPanelAssigned(side: DockSide): DockPanelId[] {
  return DOCK_PANELS.filter(
    (panel) => currentDockLayout.positions[panel] === side,
  );
}

function dockHasVisiblePanels(side: DockSide): boolean {
  return dockVisiblePanels(side).length > 0;
}

function dockSizeBounds(side: DockSide): { min: number; max: number } {
  if (side === "bottom") {
    const minEditor = Math.max(180, Math.min(460, window.innerHeight * 0.35));
    return {
      min: 100,
      max: Math.max(140, Math.floor(window.innerHeight - minEditor - 40)),
    };
  }

  const other = side === "left" ? "right" : "left";
  const otherSize = dockHasVisiblePanels(other)
    ? currentDockLayout.sizes[other]
    : 0;
  const minEditor = Math.max(260, Math.min(560, window.innerWidth * 0.4));
  return {
    min: 160,
    max: Math.max(
      200,
      Math.floor(window.innerWidth - otherSize - minEditor),
    ),
  };
}

function clampedDockSize(side: DockSide, value: number): number {
  const bounds = dockSizeBounds(side);
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

function persistDockLayout() {
  try {
    localStorage.setItem(
      DOCK_STORAGE_KEY,
      JSON.stringify(currentDockLayout),
    );
  } catch {
    // The layout still applies for this session.
  }
}

function focusDockPanel(panel: DockPanelId) {
  if (panel === "output") {
    focusOutput();
  } else {
    updateAssistantConfigHint();
    assistantQuestion.focus();
  }
}

function activateDockPanel(
  side: DockSide,
  panel: DockPanelId,
  focus = true,
) {
  currentDockLayout.active[side] = panel;
  persistDockLayout();
  renderDocks();
  if (focus) {
    focusDockPanel(panel);
  }
}

function moveDockPanel(
  panel: DockPanelId,
  side: DockSide,
  focus = true,
) {
  currentDockLayout.positions[panel] = side;
  currentDockLayout.active[side] = panel;
  persistDockLayout();
  renderDocks();
  if (focus) {
    focusDockPanel(panel);
  }
}

function renderDocks() {
  const activeElement =
    document.activeElement instanceof Node ? document.activeElement : null;

  for (const side of DOCK_SIDES) {
    const dock = dockElement(side);
    const tabs = dock.querySelector<HTMLElement>(".dock-tabs");
    const content = dock.querySelector<HTMLElement>(".dock-content");
    const resizer = dock.querySelector<HTMLElement>(".dock-resizer");
    if (!tabs || !content || !resizer) {
      continue;
    }

    const visible = dockVisiblePanels(side);
    const assigned = dockPanelAssigned(side);
    dock.hidden = visible.length === 0;

    let activePanel = currentDockLayout.active[side];
    if (!visible.includes(activePanel)) {
      activePanel = visible[0];
      if (activePanel) {
        currentDockLayout.active[side] = activePanel;
      }
    }

    tabs.replaceChildren();
    if (visible.length > 0) {
      for (const panel of visible) {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "dock-tab";
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(panel === activePanel));
        tab.classList.toggle("is-active", panel === activePanel);
        tab.textContent = DOCK_LABELS[panel];
        tab.addEventListener("click", () => {
          if (suppressDockTabClick) {
            return;
          }
          activateDockPanel(side, panel);
        });
        tab.addEventListener("pointerdown", (event) => {
          beginDockDrag(panel, event, false);
        });
        tabs.append(tab);
      }

      const grip = document.createElement("span");
      grip.className = "dock-drag-grip";
      grip.textContent = "⠿";
      grip.title = "Panel verschieben";
      grip.setAttribute("aria-hidden", "true");
      grip.addEventListener("pointerdown", (event) => {
        if (activePanel) {
          beginDockDrag(activePanel, event, true);
        }
      });
      tabs.append(grip);
    }

    for (const panel of assigned) {
      const element = dockPanelElement(panel);
      content.append(element);
      element.hidden = !(
        visible.includes(panel) && panel === activePanel
      );
    }

    if (side === "bottom") {
      const size = clampedDockSize(side, currentDockLayout.sizes[side]);
      dock.style.height = `${size}px`;
      resizer.setAttribute("aria-orientation", "horizontal");
      resizer.setAttribute("aria-valuenow", String(size));
    } else {
      const size = clampedDockSize(side, currentDockLayout.sizes[side]);
      dock.style.width = `${size}px`;
      resizer.setAttribute("aria-orientation", "vertical");
      resizer.setAttribute("aria-valuenow", String(size));
    }
    const bounds = dockSizeBounds(side);
    resizer.setAttribute("aria-valuemin", String(bounds.min));
    resizer.setAttribute("aria-valuemax", String(bounds.max));
    resizer.setAttribute("aria-label", `Größe Dock ${side}`);
  }

  if (
    activeElement &&
    ((outputPanelElement.hidden &&
      outputPanelElement.contains(activeElement)) ||
      (assistantElement.hidden &&
        assistantElement.contains(activeElement)))
  ) {
    view.focus();
  }
}

let dockDragCandidate: {
  panel: DockPanelId;
  startX: number;
  startY: number;
  moved: boolean;
} | null = null;
let dockDragSide: DockSide | null = null;
let suppressDockTabClick = false;

function setDockTarget(side: DockSide | null) {
  dockDragSide = side;
  for (const target of dockTargetsElement.querySelectorAll<HTMLElement>(
    ".dock-target",
  )) {
    target.classList.toggle(
      "is-current",
      target.dataset.side === side,
    );
  }
}

function updateDockTarget(x: number, y: number) {
  let side: DockSide | null = null;
  if (x < window.innerWidth * 0.25) {
    side = "left";
  } else if (x > window.innerWidth * 0.75) {
    side = "right";
  } else if (y > window.innerHeight * 0.72) {
    side = "bottom";
  }
  setDockTarget(side);
}

function showDockTargets() {
  dockTargetsElement.hidden = false;
  document.body.classList.add("dock-dragging");
}

function hideDockTargets() {
  dockTargetsElement.hidden = true;
  document.body.classList.remove("dock-dragging");
  setDockTarget(null);
}

function beginDockDrag(
  panel: DockPanelId,
  event: PointerEvent,
  immediate: boolean,
) {
  if (event.button !== 0) {
    return;
  }
  if (immediate) {
    event.preventDefault();
  }
  dockDragCandidate = {
    panel,
    startX: event.clientX,
    startY: event.clientY,
    moved: immediate,
  };
  if (immediate) {
    showDockTargets();
    updateDockTarget(event.clientX, event.clientY);
  }
  window.addEventListener("pointermove", handleDockPointerMove);
  window.addEventListener("pointerup", handleDockPointerUp);
  window.addEventListener("pointercancel", cancelDockDrag);
}

function handleDockPointerMove(event: PointerEvent) {
  const candidate = dockDragCandidate;
  if (!candidate) {
    return;
  }
  if (!candidate.moved) {
    if (
      Math.hypot(
        event.clientX - candidate.startX,
        event.clientY - candidate.startY,
      ) < 6
    ) {
      return;
    }
    candidate.moved = true;
    showDockTargets();
  }
  event.preventDefault();
  updateDockTarget(event.clientX, event.clientY);
}

function handleDockPointerUp() {
  const candidate = dockDragCandidate;
  const moved = candidate?.moved ?? false;
  const side = dockDragSide;
  cleanupDockDrag();
  if (moved) {
    suppressDockTabClick = true;
    window.setTimeout(() => {
      suppressDockTabClick = false;
    }, 0);
    if (candidate && side) {
      moveDockPanel(candidate.panel, side);
    }
  }
}

function cleanupDockDrag() {
  dockDragCandidate = null;
  window.removeEventListener("pointermove", handleDockPointerMove);
  window.removeEventListener("pointerup", handleDockPointerUp);
  window.removeEventListener("pointercancel", cancelDockDrag);
  hideDockTargets();
}

function cancelDockDrag() {
  cleanupDockDrag();
}

function beginDockResize(side: DockSide, event: PointerEvent) {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  const horizontal = side === "left" || side === "right";
  const start = horizontal ? event.clientX : event.clientY;
  const startSize = currentDockLayout.sizes[side];

  const move = (moveEvent: PointerEvent) => {
    const current = horizontal ? moveEvent.clientX : moveEvent.clientY;
    const delta =
      side === "left"
        ? current - start
        : side === "right"
          ? start - current
          : start - current;
    currentDockLayout.sizes[side] = clampedDockSize(
      side,
      startSize + delta,
    );
    renderDocks();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    persistDockLayout();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function resizeDockBy(side: DockSide, delta: number) {
  currentDockLayout.sizes[side] = clampedDockSize(
    side,
    currentDockLayout.sizes[side] + delta,
  );
  persistDockLayout();
  renderDocks();
}

function openDockPicker(panel: DockPanelId) {
  const title = document.createElement("h2");
  title.className = "modal-title";
  title.textContent = `${DOCK_LABELS[panel]} andocken`;

  const list = document.createElement("ul");
  list.className = "modal-list";
  list.tabIndex = 0;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Dockposition");

  const sides: DockSide[] = ["left", "right", "bottom"];
  const labels: Record<DockSide, string> = {
    left: "Links",
    right: "Rechts",
    bottom: "Unten",
  };
  const options: HTMLElement[] = [];
  let selected = sides.indexOf(currentDockLayout.positions[panel]);
  if (selected < 0) {
    selected = 0;
  }

  const update = () => {
    options.forEach((option, index) => {
      const active = index === selected;
      option.classList.toggle("is-selected", active);
      option.setAttribute("aria-selected", String(active));
    });
  };

  const choose = (index: number) => {
    moveDockPanel(panel, sides[index]);
    closeModal();
  };

  sides.forEach((side, index) => {
    const option = document.createElement("li");
    option.className = "modal-option";
    option.setAttribute("role", "option");
    const label = document.createElement("span");
    label.textContent = labels[side];
    const current = document.createElement("span");
    current.className = "modal-option-meta";
    current.textContent =
      currentDockLayout.positions[panel] === side ? "aktuell" : "";
    option.append(label, current);
    option.addEventListener("click", () => choose(index));
    options.push(option);
    list.append(option);
  });

  const modal = openModal(null, (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      selected = (selected + delta + sides.length) % sides.length;
      update();
      options[selected].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      choose(selected);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeModal();
    }
  });

  const hint = document.createElement("p");
  hint.className = "modal-hint";
  hint.textContent = "↑/↓ wählen · Enter übernehmen · Esc schließen";

  update();
  modal.append(title, list, hint);
  list.focus();
}

function restoreDefaultDockLayout() {
  currentDockLayout = cloneDockLayout(DEFAULT_DOCK_LAYOUT);
  persistDockLayout();
  renderDocks();
  showLspHint("Standardlayout wiederhergestellt.", 4000);
}

function initDockHandlers() {
  for (const side of DOCK_SIDES) {
    const resizer = dockElement(side).querySelector<HTMLElement>(
      ".dock-resizer",
    );
    if (!resizer) {
      continue;
    }
    resizer.addEventListener("pointerdown", (event) => {
      beginDockResize(side, event);
    });
    resizer.addEventListener("keydown", (event) => {
      let delta = 0;
      if (side === "left") {
        if (event.key === "ArrowRight") delta = 24;
        if (event.key === "ArrowLeft") delta = -24;
      } else if (side === "right") {
        if (event.key === "ArrowLeft") delta = 24;
        if (event.key === "ArrowRight") delta = -24;
      } else {
        if (event.key === "ArrowUp") delta = 24;
        if (event.key === "ArrowDown") delta = -24;
      }
      if (delta === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      resizeDockBy(side, event.shiftKey ? delta * 3 : delta);
    });
  }

  window.addEventListener("resize", () => renderDocks());
}

let focusDimmingScheduled = false;

function parseHexColor(value: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  const number = Number.parseInt(match[1], 16);
  return [
    (number >> 16) & 0xff,
    (number >> 8) & 0xff,
    number & 0xff,
  ];
}

function focusDimColor(strength: number): string {
  const styles = getComputedStyle(document.documentElement);
  const foreground = parseHexColor(styles.getPropertyValue("--fg"));
  const background = parseHexColor(styles.getPropertyValue("--bg"));
  if (!foreground || !background) {
    return "var(--muted)";
  }
  const foregroundRatio = Math.min(1, Math.max(0, 1 - strength / 100));
  const blend = (index: number) =>
    Math.round(
      foreground[index] * foregroundRatio +
        background[index] * (1 - foregroundRatio),
    );
  return `rgb(${blend(0)}, ${blend(1)}, ${blend(2)})`;
}

function focusDimmingApplies(): boolean {
  if (
    currentZenSettings.focusDimming === "off" ||
    currentZenSettings.focusStrength <= 0
  ) {
    return false;
  }
  return (
    currentZenSettings.focusDimming === "always" ||
    (currentZenSettings.focusDimming === "zen" && zenActive)
  );
}

function focusDimmingDecorations(): DecorationSet {
  if (!focusDimmingApplies()) {
    return Decoration.none;
  }

  const doc = view.state.doc;
  const cursorLine = doc.lineAt(view.state.selection.main.head).number;
  const context = Math.min(
    100,
    Math.max(0, Math.round(currentZenSettings.focusContextLines)),
  );
  const first = Math.max(1, cursorLine - context);
  const last = Math.min(doc.lines, cursorLine + context);
  const decorations = [];

  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    if (lineNumber >= first && lineNumber <= last) {
      continue;
    }
    decorations.push(
      Decoration.line({ class: "cm-focus-dimmed" }).range(
        doc.line(lineNumber).from,
      ),
    );
  }

  return Decoration.set(decorations, true);
}

function applyFocusDimming() {
  document.documentElement.style.setProperty(
    "--focus-dim-color",
    focusDimColor(currentZenSettings.focusStrength),
  );
  view.dispatch({
    effects: setFocusDimmingEffect.of(focusDimmingDecorations()),
  });
}

function scheduleFocusDimming() {
  if (focusDimmingScheduled) {
    return;
  }
  focusDimmingScheduled = true;
  queueMicrotask(() => {
    focusDimmingScheduled = false;
    applyFocusDimming();
  });
}

function applyZenLayout() {
  const body = document.body;
  body.classList.toggle("zen-active", zenActive);
  body.classList.toggle(
    "zen-centered",
    zenActive && currentZenSettings.width === "centered",
  );
  body.classList.toggle("zen-hide-menubar", zenHidesMenubar());
  body.classList.toggle(
    "zen-hide-snippet-bar",
    zenActive && !currentZenSettings.showSnippetBar,
  );
  body.classList.toggle(
    "zen-hide-vim",
    zenActive && !currentZenSettings.showVimStatus,
  );

  renderDocks();

  const active = document.activeElement;
  if (active instanceof Node) {
    const hideFocused =
      (menubarElement.contains(active) &&
        body.classList.contains("zen-hide-menubar")) ||
      (snippetBarElement.contains(active) &&
        body.classList.contains("zen-hide-snippet-bar"));
    if (hideFocused) {
      view.focus();
    }
  }
}

function persistZenSettings(settings: ZenSettings) {
  try {
    localStorage.setItem(ZEN_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // The settings still apply for this session.
  }
}

function applyZenSettings(settings: ZenSettings) {
  currentZenSettings = { ...settings };
  persistZenSettings(currentZenSettings);
  zenOverrides = { menubar: false, output: false, assistant: false };
  applyZenLayout();
  updateZenMenuLabel();
  applyFocusDimming();
}

function toggleZenMode() {
  if (!zenActive) {
    zenOverrides = { menubar: false, output: false, assistant: false };
    zenActive = true;
    applyZenLayout();
  } else {
    zenActive = false;
    zenOverrides = { menubar: false, output: false, assistant: false };
    applyZenLayout();
  }
  updateZenMenuLabel();
  applyFocusDimming();
}

function updateZenMenuLabel() {
  const label = document.querySelector("#zen-toggle-label");
  if (label instanceof HTMLElement) {
    label.textContent = zenActive
      ? "✓ Zen-Modus beenden"
      : "Zen-Modus umschalten";
  }
}

function openZenConfigDialog() {
  const title = document.createElement("h2");
  title.className = "modal-title";
  title.textContent = "Zen-Modus konfigurieren";

  const text = document.createElement("p");
  text.className = "modal-text";
  text.textContent =
    "Lege fest, welche Bereiche im Zen-Modus sichtbar bleiben. Der Editor ist immer sichtbar.";

  const options: {
    key: "showMenubar" | "showSnippetBar" | "showOutput" | "showAssistant" | "showVimStatus";
    label: string;
  }[] = [
    { key: "showMenubar", label: "Menüleiste und Zoom" },
    { key: "showSnippetBar", label: "Snippet-Kopfleiste" },
    { key: "showOutput", label: "Ausgabe und Debug-Ansicht" },
    { key: "showAssistant", label: "KI-Seitenleiste" },
    { key: "showVimStatus", label: "Vim-Status" },
  ];

  const list = document.createElement("div");
  list.className = "zen-options";
  const inputs = {} as Record<(typeof options)[number]["key"], HTMLInputElement>;
  for (const option of options) {
    const row = document.createElement("label");
    row.className = "zen-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = currentZenSettings[option.key];
    const textLabel = document.createElement("span");
    textLabel.textContent = option.label;
    row.append(input, textLabel);
    list.append(row);
    inputs[option.key] = input;
  }

  const widthTitle = document.createElement("div");
  widthTitle.className = "zen-section-title";
  widthTitle.textContent = "Editorbreite";

  const widthOptions = document.createElement("div");
  widthOptions.className = "zen-width-options";
  const fullLabel = document.createElement("label");
  fullLabel.className = "zen-option";
  const fullInput = document.createElement("input");
  fullInput.type = "radio";
  fullInput.name = "zen-width";
  fullInput.value = "full";
  fullInput.checked = currentZenSettings.width === "full";
  const fullText = document.createElement("span");
  fullText.textContent = "Volle Breite";
  fullLabel.append(fullInput, fullText);
  const centeredLabel = document.createElement("label");
  centeredLabel.className = "zen-option";
  const centeredInput = document.createElement("input");
  centeredInput.type = "radio";
  centeredInput.name = "zen-width";
  centeredInput.value = "centered";
  centeredInput.checked = currentZenSettings.width === "centered";
  const centeredText = document.createElement("span");
  centeredText.textContent = "Zentriert (ca. 100 Zeichen)";
  centeredLabel.append(centeredInput, centeredText);
  widthOptions.append(fullLabel, centeredLabel);

  const focusTitle = document.createElement("div");
  focusTitle.className = "zen-section-title";
  focusTitle.textContent = "Fokus-Abdunklung";

  const dimOptions = document.createElement("div");
  dimOptions.className = "zen-width-options";
  const dimModes: { value: FocusDimmingMode; label: string }[] = [
    { value: "off", label: "Aus" },
    { value: "zen", label: "Nur in Zen" },
    { value: "always", label: "Immer" },
  ];
  const dimInputs = {} as Record<FocusDimmingMode, HTMLInputElement>;
  for (const mode of dimModes) {
    const label = document.createElement("label");
    label.className = "zen-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "zen-focus-dim";
    input.value = mode.value;
    input.checked = currentZenSettings.focusDimming === mode.value;
    const textLabel = document.createElement("span");
    textLabel.textContent = mode.label;
    label.append(input, textLabel);
    dimOptions.append(label);
    dimInputs[mode.value] = input;
  }

  const contextRow = document.createElement("div");
  contextRow.className = "zen-number-row";
  const contextLabel = document.createElement("label");
  contextLabel.htmlFor = "zen-context-lines";
  contextLabel.textContent = "Kontextzeilen je Seite";
  const contextInput = document.createElement("input");
  contextInput.id = "zen-context-lines";
  contextInput.className = "zen-number-input";
  contextInput.type = "number";
  contextInput.min = "0";
  contextInput.max = "100";
  contextInput.step = "1";
  contextInput.value = String(currentZenSettings.focusContextLines);
  contextRow.append(contextLabel, contextInput);

  const strengthRow = document.createElement("div");
  strengthRow.className = "zen-number-row";
  const strengthLabel = document.createElement("label");
  strengthLabel.htmlFor = "zen-focus-strength";
  strengthLabel.textContent = "Stärke (0–80 %)";
  const strengthInput = document.createElement("input");
  strengthInput.id = "zen-focus-strength";
  strengthInput.className = "zen-number-input";
  strengthInput.type = "number";
  strengthInput.min = "0";
  strengthInput.max = "80";
  strengthInput.step = "5";
  strengthInput.value = String(currentZenSettings.focusStrength);
  strengthRow.append(strengthLabel, strengthInput);

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const applyButton = document.createElement("button");
  applyButton.type = "button";
  applyButton.className = "button button-primary";
  applyButton.textContent = "Übernehmen";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "button button-ghost";
  cancelButton.textContent = "Abbrechen";
  actions.append(applyButton, cancelButton);

  const apply = () => {
    const focusDimming = (Object.entries(dimInputs).find(
      ([, input]) => input.checked,
    )?.[0] ?? "zen") as FocusDimmingMode;
    applyZenSettings({
      showMenubar: inputs.showMenubar.checked,
      showSnippetBar: inputs.showSnippetBar.checked,
      showOutput: inputs.showOutput.checked,
      showAssistant: inputs.showAssistant.checked,
      showVimStatus: inputs.showVimStatus.checked,
      width: centeredInput.checked ? "centered" : "full",
      focusDimming,
      focusContextLines: clampInteger(
        contextInput.value,
        DEFAULT_ZEN_SETTINGS.focusContextLines,
        0,
        100,
      ),
      focusStrength: clampInteger(
        strengthInput.value,
        DEFAULT_ZEN_SETTINGS.focusStrength,
        0,
        80,
      ),
    });
    closeModal();
  };

  const modal = openModal(null, (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeModal();
    }
  });
  applyButton.addEventListener("click", apply);
  cancelButton.addEventListener("click", () => closeModal());
  modal.append(
    title,
    text,
    list,
    widthTitle,
    widthOptions,
    focusTitle,
    dimOptions,
    contextRow,
    strengthRow,
    actions,
  );
  (inputs.showVimStatus ?? inputs.showMenubar).focus();
}

function openSettingsDialog() {
  const title = document.createElement("h2");
  title.className = "modal-title";
  title.textContent = "Einstellungen";

  const section = document.createElement("div");
  section.className = "settings-section-title";
  section.textContent = "KI";

  const sourceSelect = document.createElement("select");
  sourceSelect.id = "settings-ai-source";
  sourceSelect.className = "modal-input";
  for (const profile of assistantProfiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.personal
      ? `${profile.name} (persönlich)`
      : profile.name;
    sourceSelect.append(option);
  }

  const sourceField = document.createElement("div");
  sourceField.className = "modal-field";
  const sourceLabel = document.createElement("label");
  sourceLabel.htmlFor = sourceSelect.id;
  sourceLabel.textContent = "Quelle";
  sourceField.append(sourceLabel, sourceSelect);

  const modelInput = document.createElement("input");
  modelInput.id = "settings-ai-model";
  modelInput.className = "modal-input";
  modelInput.type = "text";
  modelInput.spellcheck = false;
  modelInput.autocomplete = "off";

  const modelField = document.createElement("div");
  modelField.className = "modal-field";
  const modelLabel = document.createElement("label");
  modelLabel.htmlFor = modelInput.id;
  modelLabel.textContent = "Modell-ID";
  modelField.append(modelLabel, modelInput);

  const urlField = document.createElement("div");
  urlField.className = "modal-field";
  const urlLabel = document.createElement("label");
  urlLabel.textContent = "Zieladresse";
  const urlText = document.createElement("p");
  urlText.className = "modal-value";
  urlField.append(urlLabel, urlText);

  const hint = document.createElement("p");
  hint.className = "modal-text";
  hint.textContent =
    "Beim Absenden wird der vollständige Inhalt des Editors an die gewählte Quelle übertragen. Das Öffnen der Seitenleiste und das Markieren von Code lösen keine Anfrage aus.";

  const keyNote = document.createElement("p");
  keyNote.className = "modal-text";
  keyNote.textContent =
    "Zugangsdaten und persönliche Profile werden weiterhin aus der Backend-Konfiguration gelesen.";

  const personalNote = document.createElement("p");
  personalNote.className = "modal-text";
  personalNote.textContent =
    "Persönliches Profil: Zugangsdaten kommen aus der Backend-Konfiguration, sofern eine Umgebungsvariable hinterlegt ist.";
  personalNote.hidden = true;

  const configError = document.createElement("p");
  configError.className = "modal-hint is-error";
  configError.hidden = true;

  const error = document.createElement("p");
  error.className = "modal-hint is-error";
  error.hidden = true;

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const applyButton = document.createElement("button");
  applyButton.type = "button";
  applyButton.className = "button button-primary";
  applyButton.textContent = "Übernehmen";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "button button-ghost";
  cancelButton.textContent = "Abbrechen";
  actions.append(applyButton, cancelButton);

  const profileById = (id: string): AiProfile | null =>
    assistantProfiles.find((profile) => profile.id === id) ?? null;

  const sync = () => {
    const profile = profileById(sourceSelect.value);
    urlText.textContent = profile ? profile.base_url : "–";
    personalNote.hidden = !profile?.personal;
  };

  sourceSelect.addEventListener("change", () => {
    const profile = profileById(sourceSelect.value);
    modelInput.value = profile?.model ?? "";
    error.hidden = true;
    sync();
  });

  const apply = () => {
    const profile = profileById(sourceSelect.value);
    if (!profile) {
      error.textContent = "Keine KI-Quelle verfügbar.";
      error.hidden = false;
      return;
    }
    const model = modelInput.value.trim();
    if (!model) {
      error.textContent = "Bitte eine Modell-ID eingeben.";
      error.hidden = false;
      modelInput.focus();
      return;
    }

    aiSettings = { profileId: profile.id, model };
    persistAiSettings();
    updateAssistantConfigHint();
    closeModal();
    showLspHint("KI-Einstellungen gespeichert.", 3000);
    assistantQuestion.focus();
  };

  const initialProfile = currentProfile() ?? assistantProfiles[0] ?? null;
  if (initialProfile) {
    sourceSelect.value = initialProfile.id;
  }
  modelInput.value = aiSettings.model || initialProfile?.model || "";
  sync();

  if (aiConfigError) {
    configError.textContent = aiConfigError;
    configError.hidden = false;
  }

  const modal = openModal(null, (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeModal();
    }
  });

  applyButton.addEventListener("click", apply);
  cancelButton.addEventListener("click", () => closeModal());
  modal.append(
    title,
    section,
    sourceField,
    modelField,
    urlField,
    hint,
    personalNote,
    keyNote,
    configError,
    error,
    actions,
  );
  sourceSelect.focus();
}

async function loadProfiles() {
  try {
    const result = await invoke<AiProfiles>("ai_profiles");
    assistantProfiles = result.profiles;

    const known =
      aiSettings.profileId !== null &&
      result.profiles.some((profile) => profile.id === aiSettings.profileId);
    if (!known) {
      const preferred =
        result.profiles.find((profile) => profile.personal) ??
        result.profiles[0] ??
        null;
      aiSettings = {
        profileId: preferred?.id ?? null,
        model: preferred?.model ?? "",
      };
      persistAiSettings();
    }

    updateAssistantConfigHint();

    aiConfigError = result.config_error;
    if (result.config_error) {
      setAssistantStatus(result.config_error, "error");
    }
  } catch (error) {
    setAssistantStatus(`Profile nicht ladbar: ${String(error)}`, "error");
    assistantConfigHint.hidden = false;
  }
}

async function sendQuestion() {
  if (asking) {
    return;
  }

  const question = assistantQuestion.value.trim();
  if (!question) {
    setAssistantStatus("Bitte eine Frage eingeben.", "error");
    return;
  }

  const profile = currentProfile();
  const model = effectiveModel(profile);
  if (!profile || !model) {
    updateAssistantConfigHint();
    setAssistantStatus(
      "Keine gültige KI-Konfiguration. Bitte Quelle und Modell in den Einstellungen wählen.",
      "error",
    );
    return;
  }

  // The complete editor text is sent as-is, including unsaved changes.
  const code = view.state.doc.toString();
  const selection = validPendingSelection(code);
  const focus = selection
    ? {
        start_line: selection.startLine,
        end_line: selection.endLine,
        text: selection.text,
      }
    : null;

  asking = true;
  assistantSend.disabled = true;
  assistantAnswer.textContent = "";
  setAssistantStatus("Anfrage läuft …", "loading");

  try {
    const answer = await invoke<AiAnswer>("ask_ai", {
      profileId: profile.id,
      model: model || null,
      question,
      language: currentLanguage,
      code,
      focus,
    });
    assistantAnswer.textContent = answer.text;
    setAssistantStatus("");
  } catch (error) {
    setAssistantStatus(String(error), "error");
  } finally {
    asking = false;
    assistantSend.disabled = false;
  }
}

assistantSend.addEventListener("click", () => void sendQuestion());
assistantSettings.addEventListener("click", () => openSettingsDialog());
outputReturnButton.addEventListener("click", returnToCurrentOutput);

function updateSnippetTitle() {
  const dirty =
    lastSavedContent === null ||
    view.state.doc.toString() !== lastSavedContent ||
    currentMode !== lastSavedMode;
  snippetNameElement.textContent = currentSnippetName
    ? `${currentSnippetName}.${languageExtension(currentLanguage)}`
    : "unbenannt";
  snippetLanguageElement.textContent = languageLabel(currentLanguage);
  snippetModeElement.textContent = modeName(currentMode);
  snippetDirtyElement.hidden = !dirty;
}

function isDirty(): boolean {
  return (
    lastSavedContent === null ||
    view.state.doc.toString() !== lastSavedContent ||
    currentMode !== lastSavedMode
  );
}

function applyTheme(theme: ThemeId) {
  currentTheme = theme;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures; the theme still applies for this session.
  }
  view.dispatch({ effects: themeCompartment.reconfigure(editorTheme(theme)) });
  scheduleFocusDimming();
}

interface ActiveModal {
  root: HTMLElement;
  restoreFocus: HTMLElement | null;
  keyHandler: (event: KeyboardEvent) => void;
  passive: boolean;
}

let activeModal: ActiveModal | null = null;

function trapFocus(root: HTMLElement, event: KeyboardEvent) {
  const focusables = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, input, textarea, select, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("disabled"));
  if (focusables.length === 0) {
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function openModal(
  restoreFocus: HTMLElement | null,
  keyHandler: (event: KeyboardEvent) => void,
  passive = false,
): HTMLElement {
  closeModal(false);

  const root = document.createElement("div");
  root.className = passive ? "modal-backdrop is-passive" : "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", String(!passive));
  root.append(modal);
  modalRoot.replaceChildren(root);
  modalRoot.hidden = false;
  modalRoot.classList.toggle("is-passive", passive);

  const previous =
    restoreFocus ??
    (document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null);
  activeModal = { root, restoreFocus: previous, keyHandler, passive };

  root.addEventListener("keydown", (event) => {
    if (activeModal?.root !== root) {
      return;
    }
    if (event.key === "Tab") {
      trapFocus(root, event);
      return;
    }
    keyHandler(event);
  });

  return modal;
}

function closeModal(restoreFocus = true) {
  if (!activeModal) {
    return;
  }
  const { root, restoreFocus: previous } = activeModal;
  activeModal = null;
  root.remove();
  modalRoot.hidden = true;
  modalRoot.classList.remove("is-passive");
  if (!restoreFocus) {
    return;
  }
  if (previous && previous.isConnected) {
    previous.focus();
  } else {
    view.focus();
  }
}

function showErrorModal(message: string) {
  const title = document.createElement("h2");
  title.className = "modal-title";
  title.textContent = "Fehler";
  const text = document.createElement("p");
  text.className = "modal-text";
  text.textContent = message;
  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button button-primary";
  button.textContent = "OK";
  actions.append(button);

  const modal = openModal(null, (event) => {
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      closeModal();
    }
  });
  button.addEventListener("click", () => closeModal());
  modal.append(title, text, actions);
  button.focus();
}

function showLspHint(text: string, duration = 5000) {
  lspHintElement.textContent = text;
  lspHintElement.hidden = false;
  if (lspHintTimer !== undefined) {
    window.clearTimeout(lspHintTimer);
  }
  lspHintTimer = window.setTimeout(() => {
    lspHintElement.hidden = true;
    lspHintTimer = undefined;
  }, duration);
}

function clearLspHint() {
  if (lspHintTimer !== undefined) {
    window.clearTimeout(lspHintTimer);
  }
  lspHintTimer = undefined;
  lspHintElement.hidden = true;
}

function inVimInsertMode(view: EditorView): boolean {
  const cm = getCM(view);
  return cm ? Boolean(cm.state.vim?.insertMode) : true;
}

function inVimVisualMode(view: EditorView): boolean {
  const cm = getCM(view);
  return cm ? Boolean(cm.state.vim?.visualMode) : false;
}

let leaderPending: string[] | null = null;
let leaderHelpTimer: number | undefined;

function resetLeaderSequence() {
  leaderPending = null;
  if (leaderHelpTimer !== undefined) {
    window.clearTimeout(leaderHelpTimer);
    leaderHelpTimer = undefined;
  }
  whichKeyElement.hidden = true;
  whichKeyElement.replaceChildren();
}

function leaderHelpModel(): {
  title: string;
  entries: { key: string; label: string }[];
} | null {
  if (leaderPending === null) {
    return null;
  }
  const pending = leaderPending;
  const root = buildLeaderTree(inVimVisualMode(view));
  const node = leaderNodeAt(root, pending);
  if (!node) {
    return null;
  }
  const entries = [...node.children.entries()].map(([key, child]) => ({
    key,
    label: leaderNodeLabel(child, [...pending, key]),
  }));
  if (entries.length === 0) {
    return null;
  }
  const title =
    pending.length === 0
      ? `Leader: ${leaderKeyLabel(currentLeaderConfig.leader)}`
      : `Leader: ${leaderKeyLabel(currentLeaderConfig.leader)} + ${pending
          .map(leaderKeyLabel)
          .join(" ")}`;
  return { title, entries };
}

function renderLeaderHelp() {
  const model = leaderHelpModel();
  if (!model) {
    resetLeaderSequence();
    return;
  }

  const title = document.createElement("div");
  title.className = "which-key-title";
  title.textContent = model.title;

  const grid = document.createElement("div");
  grid.className = "which-key-grid";
  for (const entry of model.entries) {
    const item = document.createElement("div");
    item.className = "which-key-entry";
    const key = document.createElement("kbd");
    key.textContent = leaderKeyLabel(entry.key);
    const label = document.createElement("span");
    label.textContent = entry.label;
    item.append(key, label);
    grid.append(item);
  }

  const hint = document.createElement("div");
  hint.className = "which-key-hint";
  hint.textContent = "Esc schließt";

  whichKeyElement.replaceChildren(title, grid, hint);
  whichKeyElement.hidden = false;
}

function scheduleLeaderHelp() {
  if (!whichKeyElement.hidden) {
    renderLeaderHelp();
    return;
  }
  if (leaderHelpTimer !== undefined) {
    return;
  }
  leaderHelpTimer = window.setTimeout(() => {
    leaderHelpTimer = undefined;
    if (leaderPending !== null) {
      renderLeaderHelp();
    }
  }, 250);
}

function executeLeaderAction(actionId: LeaderActionId) {
  resetLeaderSequence();
  if (actionId === "assistant") {
    openAssistant();
    return;
  }
  menuActions[actionId]?.();
}

function handleLeaderKey(event: KeyboardEvent): boolean {
  if (!view.hasFocus || event.isComposing) {
    return false;
  }

  const vim = getCM(view)?.state.vim;
  if (!vim || vim.insertMode) {
    if (leaderPending !== null) {
      resetLeaderSequence();
    }
    return false;
  }

  if (event.key === "Escape") {
    if (leaderPending === null) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    resetLeaderSequence();
    return true;
  }

  if (event.key === "Shift" || event.key === "CapsLock") {
    return false;
  }

  if (event.ctrlKey || event.metaKey || event.altKey) {
    if (leaderPending !== null) {
      resetLeaderSequence();
    }
    return false;
  }

  if (event.repeat) {
    if (leaderPending !== null) {
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    return false;
  }

  if (leaderPending === null) {
    if (event.key !== currentLeaderConfig.leader) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    leaderPending = [];
    scheduleLeaderHelp();
    return true;
  }

  const printable =
    Array.from(event.key).length === 1 &&
    !/[\u0000-\u001f\u007f]/.test(event.key);
  if (!printable) {
    resetLeaderSequence();
    return false;
  }

  const candidate = [...leaderPending, event.key];
  const node = leaderNodeAt(buildLeaderTree(vim.visualMode), candidate);
  if (!node) {
    event.preventDefault();
    event.stopPropagation();
    resetLeaderSequence();
    return true;
  }

  event.preventDefault();
  event.stopPropagation();
  if (node.action) {
    executeLeaderAction(node.action);
    return true;
  }

  leaderPending = candidate;
  if (!whichKeyElement.hidden) {
    renderLeaderHelp();
  } else {
    scheduleLeaderHelp();
  }
  return true;
}

function requestCompletions(view: EditorView, force = false): boolean {
  if (currentLanguage !== "rust") {
    showLspHint(
      `Autovervollständigung ist für ${languageLabel(currentLanguage)} noch nicht verfügbar.`,
      7000,
    );
    return true;
  }
  if (currentMode !== "program") {
    showLspHint(
      `Autovervollständigung ist im Modus „${modeName(currentMode)}“ noch nicht verfügbar.`,
      7000,
    );
    return true;
  }
  if (!force && !inVimInsertMode(view)) {
    return true;
  }
  if (!lspReady || !lspClient) {
    showLspHint(
      lspStarting
        ? "rust-analyzer startet …"
        : "rust-analyzer ist nicht verfügbar.",
    );
    return true;
  }
  lspClient.sync();
  return startCompletion(view);
}

async function ensureLspListeners() {
  if (!lspListeners) {
    lspListeners = (async () => {
      await listen<string>("lsp-message", (event) => {
        for (const handler of [...lspHandlers]) {
          handler(event.payload);
        }
      });
      await listen<string>("lsp-closed", (event) => {
        lspReady = false;
        lspClient = null;
        lspHandlers.clear();
        view.dispatch({ effects: lspCompartment.reconfigure([]) });
        showLspHint(String(event.payload), 9000);
      });
    })();
  }
  return lspListeners;
}

async function startLsp(snippet: string | null, mode: ExecutionMode) {
  const generation = ++lspGeneration;
  lspStarting = false;
  lspReady = false;
  lspHandlers.clear();
  closeCompletion(view);
  view.dispatch({ effects: lspCompartment.reconfigure([]) });

  if (lspClient) {
    try {
      lspClient.disconnect();
    } catch {
      // The server is replaced below regardless.
    }
    lspClient = null;
  }

  if (currentLanguage !== "rust" || mode !== "program") {
    clearLspHint();
    return;
  }

  lspStarting = true;
  try {
    await ensureLspListeners();
    if (generation !== lspGeneration) {
      return;
    }

    const project = await invoke<{ root_uri: string; file_uri: string }>(
      "lsp_start",
      { snippet },
    );
    if (generation !== lspGeneration) {
      return;
    }

    const client = new LSPClient({
      rootUri: project.root_uri,
      timeout: 15000,
      extensions: [serverCompletion({ override: true })],
    });
    client.connect({
      send(message) {
        void invoke("lsp_send", { message }).catch((error) => {
          showLspHint(String(error));
        });
      },
      subscribe(handler) {
        lspHandlers.add(handler);
      },
      unsubscribe(handler) {
        lspHandlers.delete(handler);
      },
    });

    await Promise.race([
      client.initializing,
      new Promise<never>((_, reject) => {
        window.setTimeout(
          () => reject(new Error("rust-analyzer antwortet nicht.")),
          30000,
        );
      }),
    ]);

    if (generation !== lspGeneration) {
      client.disconnect();
      return;
    }

    lspClient = client;
    lspReady = true;
    view.dispatch({
      effects: lspCompartment.reconfigure(
        client.plugin(project.file_uri, "rust"),
      ),
    });
    clearLspHint();
  } catch (error) {
    if (generation === lspGeneration) {
      lspReady = false;
      lspClient = null;
      showLspHint(`rust-analyzer: ${String(error)}`, 9000);
    }
  } finally {
    if (generation === lspGeneration) {
      lspStarting = false;
    }
  }
}

function replaceDocument(
  content: string,
  name: string | null,
  savedContent: string | null,
  mode: ExecutionMode,
  savedMode: ExecutionMode,
  language: SnippetLanguage,
) {
  closeModal(false);
  closeCompletion(view);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: content },
    selection: { anchor: 0 },
    scrollIntoView: true,
  });
  currentSnippetName = name;
  lastSavedContent = savedContent;
  currentMode = mode;
  lastSavedMode = savedMode;
  currentLanguage = language;
  view.dispatch({
    effects: languageCompartment.reconfigure(editorLanguage(language)),
  });
  syncBreakpointMarkers();
  updateMenuAvailability();
  updateSnippetTitle();
  scheduleFocusDimming();
  view.focus();
  void startLsp(name, mode);
}

function updateZoomUi() {
  zoomValueButton.textContent = `${zoomPercent} %`;
  zoomValueButton.setAttribute(
    "aria-label",
    `Zoom zurücksetzen, aktuell ${zoomPercent} %`,
  );
  zoomOutButton.disabled = zoomPercent <= 80;
  zoomInButton.disabled = zoomPercent >= 200;
}

async function applyZoom(percent: number, persist = true) {
  const next = Math.min(200, Math.max(80, Math.round(percent / 10) * 10));
  zoomTarget = next;
  try {
    await getCurrentWebview().setZoom(next / 100);
    if (zoomTarget !== next) {
      return;
    }
    zoomPercent = next;
    updateZoomUi();
    if (persist) {
      try {
        localStorage.setItem(ZOOM_STORAGE_KEY, String(next));
      } catch {
        // The zoom still applies for this session.
      }
    }
  } catch (error) {
    console.error("Zoom konnte nicht angewendet werden", error);
    showLspHint("Zoom konnte nicht geändert werden.", 4000);
  }
}

function zoomIn() {
  void applyZoom(zoomTarget + 10);
}

function zoomOut() {
  void applyZoom(zoomTarget - 10);
}

function resetZoom() {
  void applyZoom(100);
}

function menuItems(menu: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLButtonElement>(".menu-item"),
  ).filter((item) => !item.hidden);
}

function closeMenus(restoreFocus: boolean) {
  for (const menu of Array.from(
    menubarElement.querySelectorAll<HTMLElement>(".menu"),
  )) {
    const popup = menu.querySelector<HTMLElement>(".menu-popup");
    const button = menu.querySelector<HTMLButtonElement>(".menu-button");
    if (popup) {
      popup.hidden = true;
    }
    if (button) {
      button.setAttribute("aria-expanded", "false");
    }
  }
  openMenuElement = null;
  if (restoreFocus && menuRestoreFocus) {
    if (menuRestoreFocus instanceof HTMLElement) {
      if (menuRestoreFocus.isConnected) {
        menuRestoreFocus.focus();
      }
    } else {
      menuRestoreFocus.focus();
    }
  }
  menuRestoreFocus = null;
}

function positionMenuPopup(menu: HTMLElement) {
  const popup = menu.querySelector<HTMLElement>(".menu-popup");
  if (!popup) {
    return;
  }
  popup.style.left = "0";
  popup.style.right = "auto";
  const rect = popup.getBoundingClientRect();
  if (rect.right > window.innerWidth - 8) {
    popup.style.left = "auto";
    popup.style.right = "0";
  }
}

const RUST_ONLY_MENU_ACTIONS = new Set([
  "cargo-dependencies",
  "export-snippet",
  "export-project",
  "execution-mode",
  "completion",
  "debug-toggle-breakpoint",
  "debug-continue",
  "debug-next",
  "debug-stop",
]);

function updateMenuAvailability() {
  for (const item of menubarElement.querySelectorAll<HTMLButtonElement>(
    ".menu-item[data-action]",
  )) {
    const action = item.dataset.action;
    if (action && RUST_ONLY_MENU_ACTIONS.has(action)) {
      item.hidden = currentLanguage !== "rust";
    }
  }
}

function openTopMenu(menu: HTMLElement, focusFirst = true) {
  updateMenuAvailability();
  const restore = menuRestoreFocus;
  closeMenus(false);
  menuRestoreFocus = restore ?? view;

  const button = menu.querySelector<HTMLButtonElement>(".menu-button");
  const popup = menu.querySelector<HTMLElement>(".menu-popup");
  if (!button || !popup) {
    return;
  }
  openMenuElement = menu;
  popup.hidden = false;
  button.setAttribute("aria-expanded", "true");
  positionMenuPopup(menu);
  if (focusFirst) {
    menuItems(menu)[0]?.focus();
  }
}

function focusMenubar() {
  if (openMenuElement) {
    closeMenus(true);
    return;
  }
  if (!menubarElement.contains(document.activeElement)) {
    menuRestoreFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : view;
  }
  menuButtons[0]?.focus();
}

function activateMenuItem(item: HTMLElement) {
  const action = item.dataset.action;
  if (!action) {
    return;
  }
  closeMenus(true);
  menuActions[action]?.();
}

function toggleAssistant() {
  openAssistant();
}

function toggleFocus() {
  if (outputPanelElement.contains(document.activeElement)) {
    view.focus();
    return;
  }
  if (zenHidesOutput()) {
    zenOverrides.output = true;
    applyZenLayout();
  }
  currentDockLayout.active[currentDockLayout.positions.output] = "output";
  renderDocks();
  focusOutput();
}

function gotoNextDiagnostic(): boolean {
  if (diagnosticCount(view.state) === 0) {
    return false;
  }
  view.focus();
  nextDiagnostic(view);
  return true;
}

function openShortcutsDialog() {
  const title = document.createElement("h2");
  title.className = "modal-title";
  title.textContent = "Tastenkürzel";

  const list = document.createElement("div");
  list.className = "shortcut-list";
  const shortcuts: [string, string][] = [
    ["Strg+S", "Snippet speichern"],
    ["Strg+Umschalt+D", "Cargo-Abhängigkeiten verwalten"],
    ["Strg+N", "Neues Snippet"],
    ["Strg+P", "Snippet öffnen"],
    ["Strg+Enter", "Snippet ausführen / Frage senden"],
    ["Strg+Leertaste", "Autovervollständigung"],
    ["Strg+Umschalt+L", "KI-Seitenleiste"],
    ["Strg+Umschalt+T", "Theme wechseln"],
    ["F6", "Fokus Editor/Ausgabe"],
    ["F8", "Nächste Diagnose"],
    ["F10", "Menüleiste fokussieren"],
    ["F11", "Zen-Modus umschalten"],
    ["Strg++ / Strg+-", "Zoom vergrößern/verkleinern"],
    ["Strg+0", "Zoom zurücksetzen"],
    ["Esc", "Dialog/Menü schließen"],
  ];
  for (const [keys, description] of shortcuts) {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    const key = document.createElement("kbd");
    key.textContent = keys;
    const text = document.createElement("span");
    text.textContent = description;
    row.append(key, text);
    list.append(row);
  }

  const leaderHeading = document.createElement("div");
  leaderHeading.className = "shortcut-heading";
  leaderHeading.textContent = "Leader-Belegungen";
  list.append(leaderHeading);
  for (const action of LEADER_ACTIONS) {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    const key = document.createElement("kbd");
    key.textContent = leaderSequenceLabel(
      currentLeaderConfig.mappings[action.id],
    );
    const text = document.createElement("span");
    text.textContent = action.label;
    row.append(key, text);
    list.append(row);
  }

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button button-primary";
  button.textContent = "Schließen";
  actions.append(button);

  const modal = openModal(null, (event) => {
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      closeModal();
    }
  });
  button.addEventListener("click", () => closeModal());
  modal.append(title, list, actions);
  button.focus();
}

async function openAboutDialog() {
  const title = document.createElement("h2");
  title.className = "modal-title";
  title.textContent = "Über Kritzelwerk";

  const version = await getVersion().catch(() => "0.1.0");
  const text = document.createElement("p");
  text.className = "modal-text about-text";
  text.textContent = `Kritzelwerk\nVersion ${version}\nRust-Snippets schreiben und ausführen.`;

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button button-primary";
  button.textContent = "Schließen";
  actions.append(button);

  const modal = openModal(null, (event) => {
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      closeModal();
    }
  });
  button.addEventListener("click", () => closeModal());
  modal.append(title, text, actions);
  button.focus();
}

const menuActions: Record<string, () => void> = {
  "new-snippet": () => void createNewSnippet(),
  "new-java-snippet": () => void createNewJavaSnippet(),
  "new-javascript-snippet": () => void createNewJavaScriptSnippet(),
  "open-snippet": () => void openSnippetSearch(),
  "save-snippet": () => void saveCurrentSnippet(),
  "cargo-dependencies": () => void openCargoDependencies(),
  "export-snippet": () => exportSnippetFile(),
  "import-snippet": () => void importSnippet(),
  "export-project": () => exportSnippetProject(),
  undo: () => {
    view.focus();
    undo(view);
  },
  redo: () => {
    view.focus();
    redo(view);
  },
  "select-all": () => {
    view.focus();
    selectAll(view);
  },
  completion: () => {
    view.focus();
    requestCompletions(view, true);
  },
  "theme-picker": () => openThemePicker(),
  "zen-toggle": () => toggleZenMode(),
  "zen-config": () => openZenConfigDialog(),
  "dock-output": () => openDockPicker("output"),
  "dock-assistant": () => openDockPicker("assistant"),
  "dock-reset": () => restoreDefaultDockLayout(),
  "execution-mode": () => openExecutionModePicker(),
  "leader-mappings": () => openLeaderMappingDialog(),
  settings: () => openSettingsDialog(),
  "debug-toggle-breakpoint": () => {
    view.focus();
    toggleBreakpointAtCursor();
  },
  "debug-continue": () => {
    view.focus();
    void debugContinue();
  },
  "debug-next": () => {
    view.focus();
    void debugNext();
  },
  "debug-stop": () => debugStop(),
  assistant: () => toggleAssistant(),
  "toggle-focus": () => toggleFocus(),
  "zoom-in": () => zoomIn(),
  "zoom-out": () => zoomOut(),
  "zoom-reset": () => resetZoom(),
  run: () => {
    view.focus();
    void runSnippet();
  },
  "run-history": () => void openRunHistory(),
  "next-diagnostic": () => {
    view.focus();
    gotoNextDiagnostic();
  },
  shortcuts: () => openShortcutsDialog(),
  about: () => void openAboutDialog(),
};

menuButtons.forEach((button) => {
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = button.closest<HTMLElement>(".menu");
    if (!menu) {
      return;
    }
    if (openMenuElement === menu) {
      closeMenus(false);
      button.focus();
    } else {
      openTopMenu(menu, true);
    }
  });

  button.addEventListener("mouseenter", () => {
    if (!openMenuElement) {
      return;
    }
    const menu = button.closest<HTMLElement>(".menu");
    if (menu && menu !== openMenuElement) {
      openTopMenu(menu, false);
    }
  });
});

for (const item of menubarElement.querySelectorAll<HTMLButtonElement>(
  ".menu-item",
)) {
  item.addEventListener("click", () => activateMenuItem(item));
}

document.addEventListener(
  "pointerdown",
  (event) => {
    if (openMenuElement && !menubarElement.contains(event.target as Node)) {
      closeMenus(false);
    }
  },
  true,
);

menubarElement.addEventListener("keydown", (event) => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) {
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMenus(true);
    return;
  }

  if (event.key === "Tab") {
    if (openMenuElement) {
      closeMenus(false);
    }
    return;
  }

  if (active.classList.contains("menu-button")) {
    const index = menuButtons.indexOf(active as HTMLButtonElement);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const next =
        (index + (event.key === "ArrowRight" ? 1 : -1) + menuButtons.length) %
        menuButtons.length;
      menuButtons[next]?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "Enter") {
      event.preventDefault();
      const menu = active.closest<HTMLElement>(".menu");
      if (menu) {
        openTopMenu(menu, true);
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const menu = active.closest<HTMLElement>(".menu");
      if (menu) {
        openTopMenu(menu, true);
        const items = menuItems(menu);
        items[items.length - 1]?.focus();
      }
      return;
    }
    return;
  }

  if (!active.classList.contains("menu-item")) {
    return;
  }

  const menu = openMenuElement ?? active.closest<HTMLElement>(".menu");
  if (!menu) {
    return;
  }
  const items = menuItems(menu);
  const index = items.indexOf(active as HTMLButtonElement);

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const next =
      (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
      items.length;
    items[next]?.focus();
    return;
  }

  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const topIndex = menuButtons.findIndex(
      (button) => button.closest(".menu") === menu,
    );
    const next =
      (topIndex + (event.key === "ArrowRight" ? 1 : -1) + menuButtons.length) %
      menuButtons.length;
    const nextMenu = menuButtons[next]?.closest<HTMLElement>(".menu");
    if (nextMenu) {
      openTopMenu(nextMenu, true);
    }
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    activateMenuItem(active);
  }
});

zoomOutButton.addEventListener("click", () => zoomOut());
zoomInButton.addEventListener("click", () => zoomIn());
zoomValueButton.addEventListener("click", () => resetZoom());
updateZoomUi();

interface PathDialogOptions {
  title: string;
  text: string;
  initial: string;
  actionLabel: string;
  onSubmit: (path: string) => Promise<string | null>;
  onSuccess?: () => void;
}

function openPathDialog(options: PathDialogOptions) {
  const title = document.createElement("h2");
  title.className = "modal-title";
  title.textContent = options.title;

  const text = document.createElement("p");
  text.className = "modal-text";
  text.textContent = options.text;

  const input = document.createElement("input");
  input.className = "modal-input";
  input.type = "text";
  input.spellcheck = false;
  input.value = options.initial;
  input.setAttribute("aria-label", "Pfad");

  const error = document.createElement("p");
  error.className = "modal-error";
  error.hidden = true;

  const status = document.createElement("p");
  status.className = "modal-hint";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const actionButton = document.createElement("button");
  actionButton.type = "button";
  actionButton.className = "button button-primary";
  actionButton.textContent = options.actionLabel;
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "button button-ghost";
  cancelButton.textContent = "Abbrechen";
  actions.append(actionButton, cancelButton);

  let busy = false;
  let closed = false;

  const close = () => {
    if (busy) {
      return;
    }
    closed = true;
    closeModal();
  };

  const submit = async () => {
    if (busy) {
      return;
    }
    const path = input.value.trim();
    if (!path) {
      error.textContent = "Bitte einen Pfad angeben.";
      error.hidden = false;
      return;
    }

    busy = true;
    input.disabled = true;
    actionButton.disabled = true;
    cancelButton.disabled = true;
    error.hidden = true;
    status.textContent = "Arbeite …";

    try {
      const failure = await options.onSubmit(path);
      if (closed) {
        return;
      }
      if (failure) {
        error.textContent = failure;
        error.hidden = false;
        status.textContent = "";
      } else {
        closed = true;
        closeModal();
        options.onSuccess?.();
        return;
      }
    } catch (failure) {
      if (!closed) {
        error.textContent = String(failure);
        error.hidden = false;
        status.textContent = "";
      }
    } finally {
      if (!closed) {
        busy = false;
        input.disabled = false;
        actionButton.disabled = false;
        cancelButton.disabled = false;
        if (!error.hidden) {
          input.focus();
          input.select();
        }
      }
    }
  };

  const modal = openModal(null, (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && event.target === input) {
      event.preventDefault();
      event.stopPropagation();
      void submit();
    }
  });

  actionButton.addEventListener("click", () => void submit());
  cancelButton.addEventListener("click", close);
  modal.append(title, text, input, error, status, actions);
  input.focus();
  input.select();
}

function requireSavedSnippet(): string | null {
  if (currentSnippetName === null) {
    showErrorModal(
      "Bitte speichere das Snippet zuerst, bevor du es exportierst.",
    );
    return null;
  }
  return currentSnippetName;
}

function exportSnippetFile() {
  if (currentLanguage !== "rust") {
    showLspHint("Snippet-Export ist nur für Rust verfügbar.", 5000);
    return;
  }
  const name = requireSavedSnippet();
  if (name === null) {
    return;
  }
  const contents = view.state.doc.toString();
  const mode = currentMode;

  openPathDialog({
    title: "Snippet exportieren",
    text: "Zielpfad für die versionierte .kritzelwerk.json-Datei (absolut oder ~/…). Vorhandene Dateien werden nicht überschrieben.",
    initial: `~/${name}.kritzelwerk.json`,
    actionLabel: "Exportieren",
    onSubmit: async (path) => {
      try {
        const result = await invoke<ExportResult>("export_snippet_file", {
          path,
          name,
          contents,
          mode,
        });
        showLspHint(`Snippet exportiert: ${result.path}`, 9000);
        return null;
      } catch (failure) {
        return String(failure);
      }
    },
  });
}

async function importSnippet() {
  if (!(await guardUnsaved())) {
    return;
  }

  let preview: ImportPreview | null = null;
  let sourcePath = "";

  openPathDialog({
    title: "Snippet importieren",
    text: "Pfad zur .kritzelwerk.json-Datei (absolut oder ~/…). Es wird nichts ausgeführt und Cargo nicht gestartet.",
    initial: "~/",
    actionLabel: "Weiter",
    onSubmit: async (path) => {
      try {
        preview = await invoke<ImportPreview>("inspect_import", { path });
        sourcePath = path;
        return null;
      } catch (failure) {
        return String(failure);
      }
    },
    onSuccess: () => {
      if (preview) {
        showImportPreview(sourcePath, preview);
      }
    },
  });
}

function exportSnippetProject() {
  if (currentLanguage !== "rust") {
    showLspHint(
      "Der Cargo-Projekt-Export ist nur für Rust verfügbar.",
      5000,
    );
    return;
  }
  const name = requireSavedSnippet();
  if (name === null) {
    return;
  }
  const contents = view.state.doc.toString();
  const mode = currentMode;

  openPathDialog({
    title: "Als Cargo-Projekt exportieren",
    text: "Zielordner für Cargo.toml, src/main.rs, src/lib.rs, README.md und ein passendes Cargo.lock. Der Ordner muss leer oder neu sein; vorhandene Dateien werden nicht überschrieben.",
    initial: `~/${name}`,
    actionLabel: "Exportieren",
    onSubmit: async (path) => {
      try {
        const result = await invoke<ProjectExportResult>("export_project", {
          path,
          name,
          contents,
          mode,
        });
        const start = result.locked ? "cargo run --locked" : "cargo run";
        showLspHint(
          `Cargo-Projekt exportiert: ${result.path} · Start: ${start}`,
          10000,
        );
        return null;
      } catch (failure) {
        return String(failure);
      }
    },
  });
}

function showImportPreview(path: string, preview: ImportPreview) {
  const title = document.createElement("h2");
  title.className = "modal-title";
  title.textContent = "Snippet importieren";

  const text = document.createElement("p");
  text.className = "modal-text";
  text.textContent = `Datei: ${path}`;

  const details = document.createElement("dl");
  details.className = "import-details";
  const addDetail = (label: string, value: string) => {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    details.append(term, description);
  };
  addDetail("Formatversion", String(preview.version));
  addDetail("Modus", modeName(normalizeExecutionMode(preview.mode)));
  addDetail(
    "Abhängigkeiten",
    preview.dependencies.length === 0
      ? "keine"
      : preview.dependencies
          .map((dependency) =>
            dependency.features.length > 0
              ? `${dependency.name} ${dependency.version} [${dependency.features.join(", ")}]`
              : `${dependency.name} ${dependency.version}`,
          )
          .join("\n"),
  );
  addDetail("Lockfile", preview.has_lockfile ? "vorhanden" : "nicht vorhanden");

  const field = document.createElement("div");
  field.className = "modal-field";
  const label = document.createElement("label");
  label.textContent = "Name im Kritzelwerk";
  label.htmlFor = "import-name";
  const nameInput = document.createElement("input");
  nameInput.id = "import-name";
  nameInput.className = "modal-input";
  nameInput.type = "text";
  nameInput.spellcheck = false;
  nameInput.value = preview.name;
  field.append(label, nameInput);

  const error = document.createElement("p");
  error.className = "modal-error";
  error.hidden = true;
  if (preview.name_taken) {
    error.textContent = `Ein Snippet „${preview.name}“ existiert bereits. Bitte einen neuen Namen eingeben.`;
    error.hidden = false;
  }

  const status = document.createElement("p");
  status.className = "modal-hint";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const importButton = document.createElement("button");
  importButton.type = "button";
  importButton.className = "button button-primary";
  importButton.textContent = "Importieren";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "button button-ghost";
  cancelButton.textContent = "Abbrechen";
  actions.append(importButton, cancelButton);

  let busy = false;
  let closed = false;

  const close = () => {
    if (busy) {
      return;
    }
    closed = true;
    closeModal();
  };

  const submit = async () => {
    if (busy) {
      return;
    }
    const name = nameInput.value.trim();
    if (!name) {
      error.textContent = "Bitte einen Namen eingeben.";
      error.hidden = false;
      return;
    }

    busy = true;
    nameInput.disabled = true;
    importButton.disabled = true;
    cancelButton.disabled = true;
    error.hidden = true;
    status.textContent = "Importiere …";

    try {
      const result = await invoke<ImportResult>("import_snippet", {
        path,
        name,
      });
      if (closed) {
        return;
      }
      closed = true;
      closeModal();
      showLspHint(`Snippet „${result.name}“ importiert.`, 8000);
    } catch (failure) {
      if (!closed) {
        error.textContent = String(failure);
        error.hidden = false;
        status.textContent = "";
        nameInput.disabled = false;
        importButton.disabled = false;
        cancelButton.disabled = false;
        busy = false;
        nameInput.focus();
        nameInput.select();
      }
    }
  };

  const modal = openModal(null, (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && event.target === nameInput) {
      event.preventDefault();
      event.stopPropagation();
      void submit();
    }
  });

  importButton.addEventListener("click", () => void submit());
  cancelButton.addEventListener("click", close);

  const hint = document.createElement("p");
  hint.className = "modal-hint";
  hint.textContent = "Enter importiert · Esc bricht ab";

  modal.append(title, text, details, field, error, status, hint, actions);
  nameInput.focus();
  nameInput.select();
}

function promptForSnippetName(): Promise<boolean> {
  return new Promise((resolve) => {
    const title = document.createElement("h2");
    title.className = "modal-title";
    title.textContent = "Snippet speichern";

    const text = document.createElement("p");
    text.className = "modal-text";
    text.textContent = `Name für das ${languageLabel(currentLanguage)}-Snippet (ohne Pfad, .${languageExtension(currentLanguage)} wird automatisch ergänzt):`;

    const input = document.createElement("input");
    input.className = "modal-input";
    input.type = "text";
    input.spellcheck = false;
    input.value = currentSnippetName ?? "";

    const error = document.createElement("p");
    error.className = "modal-error";
    error.hidden = true;

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "button button-primary";
    saveButton.textContent = "Speichern";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "button button-ghost";
    cancelButton.textContent = "Abbrechen";
    actions.append(saveButton, cancelButton);

    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    const submit = async () => {
      const raw = input.value.trim();
      if (!raw) {
        error.textContent = "Bitte einen Namen eingeben.";
        error.hidden = false;
        return;
      }
      if (raw.includes("/") || raw.includes("\\")) {
        error.textContent = "Der Name darf keine Pfadtrenner enthalten.";
        error.hidden = false;
        return;
      }
      try {
        const result = await invoke<SaveResult>("save_snippet", {
          name: raw,
          contents: view.state.doc.toString(),
          overwrite: false,
          mode: currentMode,
          language: currentLanguage,
        });
        if (result.status === "exists") {
          error.textContent = `Ein ${languageLabel(currentLanguage)}-Snippet „${result.name}“ existiert bereits.`;
          error.hidden = false;
          return;
        }
        currentSnippetName = result.name;
        lastSavedContent = view.state.doc.toString();
        lastSavedMode = currentMode;
        const anonymousKey = `${currentLanguage}:__unbenannt__`;
        const anonymousBreakpoints = breakpointsBySnippet.get(anonymousKey);
        if (anonymousBreakpoints) {
          breakpointsBySnippet.delete(anonymousKey);
          breakpointsBySnippet.set(
            `${currentLanguage}:${result.name}`,
            anonymousBreakpoints,
          );
        }
        syncBreakpointMarkers();
        updateSnippetTitle();
        closeModal();
        finish(true);
      } catch (failure) {
        error.textContent = String(failure);
        error.hidden = false;
      }
    };

    const modal = openModal(null, (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeModal();
        finish(false);
      } else if (event.key === "Enter" && event.target === input) {
        event.preventDefault();
        event.stopPropagation();
        void submit();
      }
    });

    saveButton.addEventListener("click", () => void submit());
    cancelButton.addEventListener("click", () => {
      closeModal();
      finish(false);
    });

    modal.append(title, text, input, error, actions);
    input.focus();
    input.select();
  });
}

async function saveCurrentSnippet(): Promise<boolean> {
  if (currentSnippetName === null) {
    return promptForSnippetName();
  }

  try {
    const contents = view.state.doc.toString();
    const result = await invoke<SaveResult>("save_snippet", {
      name: currentSnippetName,
      contents,
      overwrite: true,
      mode: currentMode,
      language: currentLanguage,
    });
    if (result.status !== "saved") {
      return false;
    }
    lastSavedContent = contents;
    lastSavedMode = currentMode;
    updateSnippetTitle();
    return true;
  } catch (failure) {
    showErrorModal(String(failure));
    return false;
  }
}

type UnsavedChoice = "save" | "discard" | "cancel";

function askUnsaved(): Promise<UnsavedChoice> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice: UnsavedChoice) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(choice);
    };

    const modal = openModal(null, (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeModal();
        finish("cancel");
      }
    });

    const title = document.createElement("h2");
    title.className = "modal-title";
    title.textContent = "Ungespeicherte Änderungen";

    const text = document.createElement("p");
    text.className = "modal-text";
    text.textContent =
      "Das aktuelle Snippet wurde noch nicht gespeichert. Was soll damit geschehen?";

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "button button-primary";
    saveButton.textContent = "Speichern";
    const discardButton = document.createElement("button");
    discardButton.type = "button";
    discardButton.className = "button";
    discardButton.textContent = "Verwerfen";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "button button-ghost";
    cancelButton.textContent = "Abbrechen";
    actions.append(saveButton, discardButton, cancelButton);

    saveButton.addEventListener("click", () => {
      closeModal();
      finish("save");
    });
    discardButton.addEventListener("click", () => {
      closeModal();
      finish("discard");
    });
    cancelButton.addEventListener("click", () => {
      closeModal();
      finish("cancel");
    });

    modal.append(title, text, actions);
    saveButton.focus();
  });
}

async function guardUnsaved(): Promise<boolean> {
  if (!isDirty()) {
    return true;
  }
  const choice = await askUnsaved();
  if (choice === "cancel") {
    return false;
  }
  if (choice === "discard") {
    return true;
  }
  return saveCurrentSnippet();
}

interface DependencyRow {
  root: HTMLElement;
  name: HTMLInputElement;
  version: HTMLInputElement;
  features: HTMLInputElement;
  resolved: HTMLElement;
  remove: HTMLButtonElement;
}

function splitFeatureList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((feature) => feature.trim())
    .filter((feature) => feature.length > 0);
}

function dependencySpecs(rows: DependencyRow[]): {
  name: string;
  version: string;
  features: string[];
}[] {
  const specs: { name: string; version: string; features: string[] }[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const name = row.name.value.trim();
    const version = row.version.value.trim();
    const features = splitFeatureList(row.features.value);

    if (!name && !version && features.length === 0) {
      continue;
    }
    if (!name) {
      throw new Error("Bitte für jede Abhängigkeit einen Crate-Namen angeben.");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(
        `„${name}“ ist kein gültiger Crate-Name (erlaubt: Buchstaben, Ziffern, _ und -).`,
      );
    }
    if (!version) {
      throw new Error(`Für „${name}“ fehlt die Versionsanforderung.`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`„${name}“ ist doppelt eingetragen.`);
    }
    seen.add(key);
    specs.push({ name, version, features });
  }

  return specs;
}

async function openCargoDependencies() {
  if (currentLanguage !== "rust") {
    showLspHint(
      "Cargo-Abhängigkeiten sind nur für Rust verfügbar.",
      5000,
    );
    return;
  }
  if (currentSnippetName === null) {
    const saved = await promptForSnippetName();
    if (!saved || currentSnippetName === null) {
      return;
    }
  }

  const snippetName = currentSnippetName;
  let config: CargoDependencyConfig;
  try {
    config = await invoke<CargoDependencyConfig>("dependencies_get", {
      name: snippetName,
    });
  } catch (failure) {
    showErrorModal(String(failure));
    return;
  }

  showDependencyDialog(snippetName, config.dependencies);
}

function showDependencyDialog(
  snippetName: string,
  initial: CargoDependency[],
) {
  const title = document.createElement("h2");
  title.className = "modal-title";
  title.textContent = "Cargo-Abhängigkeiten";

  const text = document.createElement("p");
  text.className = "modal-text";
  text.textContent = `Abhängigkeiten für „${snippetName}.rs“ (crates.io). „Übernehmen“ löst die Versionen mit Cargo auf und speichert sie erst bei Erfolg.`;

  const head = document.createElement("div");
  head.className = "dependency-head";
  for (const label of ["Crate", "Version", "Features (optional)", "Aufgelöst"]) {
    const cell = document.createElement("span");
    cell.textContent = label;
    head.append(cell);
  }
  head.append(document.createElement("span"));

  const rowsElement = document.createElement("div");
  rowsElement.className = "dependency-rows";

  const empty = document.createElement("p");
  empty.className = "modal-empty";
  empty.textContent = "Noch keine Abhängigkeiten eingetragen.";
  empty.hidden = true;

  const rows: DependencyRow[] = [];

  const updateEmpty = () => {
    empty.hidden = rows.length > 0;
  };

  const addRow = (dependency?: CargoDependency): DependencyRow => {
    const root = document.createElement("div");
    root.className = "dependency-row";

    const name = document.createElement("input");
    name.className = "dep-input dep-name";
    name.type = "text";
    name.spellcheck = false;
    name.placeholder = "z. B. regex";
    name.setAttribute("aria-label", "Crate-Name");
    name.value = dependency?.name ?? "";

    const version = document.createElement("input");
    version.className = "dep-input dep-version";
    version.type = "text";
    version.spellcheck = false;
    version.placeholder = "z. B. 1";
    version.setAttribute("aria-label", "Versionsanforderung");
    version.value = dependency?.version ?? "";

    const features = document.createElement("input");
    features.className = "dep-input dep-features";
    features.type = "text";
    features.spellcheck = false;
    features.placeholder = "z. B. derive, std";
    features.setAttribute("aria-label", "Features, durch Kommas getrennt");
    features.value = (dependency?.features ?? []).join(", ");

    const resolved = document.createElement("span");
    resolved.className = "dependency-resolved";
    resolved.textContent = dependency?.resolved
      ? `aufgelöst: ${dependency.resolved}`
      : "aufgelöst: –";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button button-ghost dependency-remove";
    remove.textContent = "Entfernen";
    remove.setAttribute(
      "aria-label",
      `Abhängigkeit ${dependency?.name ?? "ohne Namen"} entfernen`,
    );

    const row: DependencyRow = {
      root,
      name,
      version,
      features,
      resolved,
      remove,
    };

    remove.addEventListener("click", () => {
      const index = rows.indexOf(row);
      if (index >= 0) {
        rows.splice(index, 1);
      }
      root.remove();
      updateEmpty();
      const previous = rows[index] ?? rows[index - 1];
      (previous?.name ?? addButton).focus();
    });

    root.append(name, version, features, resolved, remove);
    rows.push(row);
    rowsElement.append(root);
    updateEmpty();
    return row;
  };

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "button";
  addButton.textContent = "Abhängigkeit hinzufügen";

  const error = document.createElement("p");
  error.className = "modal-error";
  error.hidden = true;

  const status = document.createElement("p");
  status.className = "modal-hint";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const applyButton = document.createElement("button");
  applyButton.type = "button";
  applyButton.className = "button button-primary";
  applyButton.textContent = "Übernehmen";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "button button-ghost";
  cancelButton.textContent = "Abbrechen";
  actions.append(applyButton, cancelButton);

  for (const dependency of initial) {
    addRow(dependency);
  }

  let busy = false;
  let closed = false;
  let requestId: string | null = null;
  let progressTimer: number | undefined;

  const setBusy = (value: boolean) => {
    busy = value;
    applyButton.disabled = value;
    addButton.disabled = value;
    for (const row of rows) {
      row.name.disabled = value;
      row.version.disabled = value;
      row.features.disabled = value;
      row.remove.disabled = value;
    }
    cancelButton.textContent = value ? "Abbrechen" : cancelButton.textContent;
  };

  const stopProgress = () => {
    if (progressTimer !== undefined) {
      window.clearInterval(progressTimer);
      progressTimer = undefined;
    }
  };

  const close = () => {
    closed = true;
    stopProgress();
    closeModal();
  };

  const cancelResolution = () => {
    if (requestId) {
      void invoke("dependencies_cancel", { requestId }).catch(() => {
        // The previous configuration stays active either way.
      });
      requestId = null;
    }
    close();
  };

  const showProgress = () => {
    const started = Date.now();
    const tick = () => {
      if (!status.isConnected) {
        closed = true;
        stopProgress();
        return;
      }
      const seconds = Math.floor((Date.now() - started) / 1000);
      status.textContent =
        seconds > 0
          ? `Löse Abhängigkeiten mit Cargo auf … ${seconds} s`
          : "Löse Abhängigkeiten mit Cargo auf …";
    };
    tick();
    stopProgress();
    progressTimer = window.setInterval(tick, 1000);
  };

  const apply = async () => {
    if (busy) {
      return;
    }

    let specs: { name: string; version: string; features: string[] }[];
    try {
      specs = dependencySpecs(rows);
    } catch (failure) {
      error.textContent = String(failure instanceof Error ? failure.message : failure);
      error.hidden = false;
      return;
    }

    error.hidden = true;
    setBusy(true);
    status.className = "modal-hint is-loading";
    showProgress();

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    requestId = id;

    try {
      const result = await invoke<CargoDependencyConfig>(
        "dependencies_resolve",
        { name: snippetName, dependencies: specs, requestId: id },
      );
      if (requestId !== id) {
        return;
      }
      requestId = null;
      stopProgress();
      if (snippetName === currentSnippetName) {
        void startLsp(snippetName, currentMode);
      }
      if (closed || !status.isConnected) {
        return;
      }
      const byName = new Map(
        result.dependencies.map((dependency) => [dependency.name, dependency]),
      );
      for (const row of rows) {
        const dependency = byName.get(row.name.value.trim());
        if (!dependency) {
          continue;
        }
        row.name.value = dependency.name;
        row.version.value = dependency.version;
        row.features.value = dependency.features.join(", ");
        row.resolved.textContent = dependency.resolved
          ? `aufgelöst: ${dependency.resolved}`
          : "aufgelöst: –";
      }
      status.className = "modal-hint is-success";
      status.textContent = "Abhängigkeiten übernommen.";
      cancelButton.textContent = "Schließen";
    } catch (failure) {
      if (requestId !== id) {
        return;
      }
      requestId = null;
      stopProgress();
      if (closed || !status.isConnected) {
        return;
      }
      status.className = "modal-hint";
      status.textContent = "";
      error.textContent = String(failure);
      error.hidden = false;
    } finally {
      if (!closed) {
        setBusy(false);
        cancelButton.textContent =
          status.classList.contains("is-success") ? "Schließen" : "Abbrechen";
      }
    }
  };

  const modal = openModal(null, (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (busy) {
        cancelResolution();
      } else {
        close();
      }
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key === "Enter"
    ) {
      event.preventDefault();
      event.stopPropagation();
      void apply();
    }
  }, true);
  modal.classList.add("modal-wide");

  applyButton.addEventListener("click", () => void apply());
  cancelButton.addEventListener("click", () => {
    if (busy) {
      cancelResolution();
    } else {
      close();
    }
  });
  addButton.addEventListener("click", () => {
    const row = addRow();
    row.name.focus();
  });

  const hint = document.createElement("p");
  hint.className = "modal-hint";
  hint.textContent =
    "Tab wechselt Felder · Strg+Enter übernimmt · Esc bricht ab";

  modal.append(
    title,
    text,
    head,
    rowsElement,
    empty,
    addButton,
    error,
    status,
    hint,
    actions,
  );
  updateEmpty();

  if (rows.length > 0) {
    rows[0].name.focus();
    rows[0].name.select();
  } else {
    addButton.focus();
  }
}

async function createNewSnippet() {
  if (debugBlocksEditing()) {
    return;
  }
  if (!(await guardUnsaved())) {
    return;
  }
  replaceDocument(
    NEW_SNIPPET,
    null,
    null,
    "expression",
    "expression",
    "rust",
  );
}

async function createNewJavaSnippet() {
  if (debugBlocksEditing()) {
    return;
  }
  if (!(await guardUnsaved())) {
    return;
  }
  replaceDocument(
    NEW_JAVA_SNIPPET,
    null,
    null,
    "program",
    "program",
    "java",
  );
}

async function createNewJavaScriptSnippet() {
  if (debugBlocksEditing()) {
    return;
  }
  if (!(await guardUnsaved())) {
    return;
  }
  replaceDocument(
    NEW_JAVASCRIPT_SNIPPET,
    null,
    null,
    "program",
    "program",
    "javascript",
  );
}

function applyExecutionMode(mode: ExecutionMode) {
  if (currentLanguage !== "rust") {
    showLspHint(
      "Der Ausführungsmodus ist nur für Rust verfügbar.",
      5000,
    );
    return;
  }
  if (mode === currentMode) {
    return;
  }
  currentMode = mode;
  updateSnippetTitle();
  void startLsp(currentSnippetName, mode);
}

function openLeaderMappingDialog() {
  const title = document.createElement("h2");
  title.className = "modal-title";
  title.textContent = "Leader-Belegungen";

  const text = document.createElement("p");
  text.className = "modal-text";
  text.textContent =
    "Leader ist die Leertaste oder ein einzelnes druckbares Zeichen. Folgen bestehen aus 1 bis 3 Zeichen, z. B. r oder x r. Leer bedeutet: nur im Menü verfügbar. Änderungen werden erst mit „Übernehmen“ aktiv.";

  const leaderField = document.createElement("div");
  leaderField.className = "leader-mapping-row";
  const leaderLabel = document.createElement("label");
  leaderLabel.htmlFor = "leader-key";
  leaderLabel.textContent = "Leader";
  const leaderInputWrap = document.createElement("div");
  leaderInputWrap.className = "leader-mapping-input";
  const leaderInput = document.createElement("input");
  leaderInput.id = "leader-key";
  leaderInput.className = "modal-input";
  leaderInput.type = "text";
  leaderInput.spellcheck = false;
  leaderInput.value =
    currentLeaderConfig.leader === " "
      ? "Leertaste"
      : currentLeaderConfig.leader;
  const leaderError = document.createElement("p");
  leaderError.className = "modal-field-error";
  leaderError.hidden = true;
  leaderInputWrap.append(leaderInput, leaderError);
  leaderField.append(leaderLabel, leaderInputWrap);

  const mappings = document.createElement("div");
  mappings.className = "leader-mappings";
  const actionInputs = {} as Record<LeaderActionId, HTMLInputElement>;
  const actionErrors = {} as Record<LeaderActionId, HTMLParagraphElement>;

  for (const action of LEADER_ACTIONS) {
    const row = document.createElement("div");
    row.className = "leader-mapping-row";
    const label = document.createElement("label");
    label.htmlFor = `leader-sequence-${action.id}`;
    label.textContent = action.label;
    const inputWrap = document.createElement("div");
    inputWrap.className = "leader-mapping-input";
    const input = document.createElement("input");
    input.id = `leader-sequence-${action.id}`;
    input.className = "modal-input";
    input.type = "text";
    input.spellcheck = false;
    input.value = currentLeaderConfig.mappings[action.id].join(" ");
    const error = document.createElement("p");
    error.className = "modal-field-error";
    error.hidden = true;
    inputWrap.append(input, error);
    row.append(label, inputWrap);
    mappings.append(row);
    actionInputs[action.id] = input;
    actionErrors[action.id] = error;
  }

  const status = document.createElement("p");
  status.className = "modal-hint";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const restoreButton = document.createElement("button");
  restoreButton.type = "button";
  restoreButton.className = "button button-ghost leader-restore";
  restoreButton.textContent = "Standards wiederherstellen";
  const applyButton = document.createElement("button");
  applyButton.type = "button";
  applyButton.className = "button button-primary";
  applyButton.textContent = "Übernehmen";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "button button-ghost";
  cancelButton.textContent = "Abbrechen";
  actions.append(restoreButton, applyButton, cancelButton);

  const readValues = (): Record<LeaderActionId, string> => {
    const values = {} as Record<LeaderActionId, string>;
    for (const action of LEADER_ACTIONS) {
      values[action.id] = actionInputs[action.id].value;
    }
    return values;
  };

  const refreshErrors = (): LeaderValidation => {
    const validation = validateLeaderConfiguration(
      leaderInput.value,
      readValues(),
    );
    leaderError.textContent = validation.leaderError ?? "";
    leaderError.hidden = !validation.leaderError;
    for (const action of LEADER_ACTIONS) {
      const message = validation.actionErrors[action.id];
      actionErrors[action.id].textContent = message ?? "";
      actionErrors[action.id].hidden = !message;
    }
    return validation;
  };

  const setFormValues = (config: LeaderConfig) => {
    leaderInput.value = config.leader === " " ? "Leertaste" : config.leader;
    for (const action of LEADER_ACTIONS) {
      actionInputs[action.id].value = config.mappings[action.id].join(" ");
    }
  };

  const submit = () => {
    const validation = refreshErrors();
    if (!validation.config) {
      status.textContent = "Bitte die markierten Felder korrigieren.";
      status.className = "modal-hint is-error";
      const firstInvalid =
        LEADER_ACTIONS.find((action) => validation.actionErrors[action.id]) ??
        null;
      if (validation.leaderError) {
        leaderInput.focus();
        leaderInput.select();
      } else if (firstInvalid) {
        actionInputs[firstInvalid.id].focus();
        actionInputs[firstInvalid.id].select();
      }
      return;
    }
    applyLeaderConfig(validation.config);
    closeModal();
    showLspHint("Leader-Belegungen übernommen.", 5000);
  };

  const restoreDefaults = () => {
    const defaults = cloneLeaderConfig(DEFAULT_LEADER_CONFIG);
    applyLeaderConfig(defaults);
    setFormValues(defaults);
    refreshErrors();
    status.textContent = "Standards wiederhergestellt.";
    status.className = "modal-hint is-success";
    leaderInput.focus();
    leaderInput.select();
  };

  leaderInput.addEventListener("input", () => {
    status.textContent = "";
    status.className = "modal-hint";
    refreshErrors();
  });
  for (const action of LEADER_ACTIONS) {
    actionInputs[action.id].addEventListener("input", () => {
      status.textContent = "";
      status.className = "modal-hint";
      refreshErrors();
    });
  }

  const modal = openModal(null, (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeModal();
    } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      event.stopPropagation();
      submit();
    }
  });

  restoreButton.addEventListener("click", restoreDefaults);
  applyButton.addEventListener("click", submit);
  cancelButton.addEventListener("click", () => closeModal());

  modal.append(
    title,
    text,
    leaderField,
    mappings,
    status,
    actions,
  );
  refreshErrors();
  leaderInput.focus();
  leaderInput.select();
}

function openExecutionModePicker() {
  if (currentLanguage !== "rust") {
    showLspHint(
      "Der Ausführungsmodus ist nur für Rust verfügbar.",
      5000,
    );
    return;
  }
  if (debugBlocksEditing()) {
    return;
  }
  const title = document.createElement("h2");
  title.className = "modal-title";
  title.textContent = "Ausführungsmodus";

  const list = document.createElement("ul");
  list.className = "modal-list";
  list.tabIndex = 0;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Ausführungsmodus");

  const options: HTMLElement[] = [];
  let selected = EXECUTION_MODES.findIndex(
    (entry) => entry.id === currentMode,
  );
  if (selected < 0) {
    selected = 0;
  }

  const update = () => {
    options.forEach((option, index) => {
      const active = index === selected;
      option.classList.toggle("is-selected", active);
      option.setAttribute("aria-selected", String(active));
    });
  };

  const choose = (index: number) => {
    selected = index;
    applyExecutionMode(EXECUTION_MODES[index].id);
    closeModal();
  };

  EXECUTION_MODES.forEach((mode, index) => {
    const option = document.createElement("li");
    option.className = "modal-option mode-option";
    option.setAttribute("role", "option");
    const label = document.createElement("span");
    label.textContent = mode.name;
    const hint = document.createElement("span");
    hint.className = "mode-hint";
    hint.textContent = mode.hint;
    option.append(label, hint);
    option.addEventListener("click", () => choose(index));
    options.push(option);
    list.append(option);
  });

  const modal = openModal(null, (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      selected = (selected + delta + EXECUTION_MODES.length) %
        EXECUTION_MODES.length;
      update();
      options[selected].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      choose(selected);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeModal();
    }
  });

  const hint = document.createElement("p");
  hint.className = "modal-hint";
  hint.textContent = "↑/↓ wählen · Enter übernehmen · Esc schließen";

  update();
  modal.append(title, list, hint);
  list.focus();
}

function openThemePicker() {
  const title = document.createElement("h2");
  title.className = "modal-title";
  title.textContent = "Theme wählen";

  const list = document.createElement("ul");
  list.className = "modal-list";
  list.tabIndex = 0;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Theme");

  const options: HTMLElement[] = [];
  let selected = THEMES.findIndex((theme) => theme.id === currentTheme);
  if (selected < 0) {
    selected = 0;
  }

  const update = () => {
    options.forEach((option, index) => {
      const active = index === selected;
      option.classList.toggle("is-selected", active);
      option.setAttribute("aria-selected", String(active));
    });
  };

  const choose = (index: number) => {
    selected = index;
    applyTheme(THEMES[index].id);
    closeModal();
  };

  THEMES.forEach((theme, index) => {
    const option = document.createElement("li");
    option.className = "modal-option";
    option.setAttribute("role", "option");
    const swatch = document.createElement("span");
    swatch.className = `theme-swatch theme-swatch-${theme.id}`;
    const label = document.createElement("span");
    label.textContent = theme.name;
    option.append(swatch, label);
    option.addEventListener("click", () => choose(index));
    options.push(option);
    list.append(option);
  });

  const modal = openModal(null, (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      selected = (selected + delta + THEMES.length) % THEMES.length;
      update();
      options[selected].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      choose(selected);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeModal();
    }
  });

  const hint = document.createElement("p");
  hint.className = "modal-hint";
  hint.textContent = "↑/↓ wählen · Enter übernehmen · Esc schließen";

  update();
  modal.append(title, list, hint);
  list.focus();
}

async function openSnippetSearch() {
  if (debugBlocksEditing()) {
    return;
  }
  let snippets: SnippetInfo[];
  try {
    snippets = await invoke<SnippetInfo[]>("list_snippets");
  } catch (failure) {
    showErrorModal(String(failure));
    return;
  }

  const title = document.createElement("h2");
  title.className = "modal-title";
  title.textContent = "Snippet öffnen";

  const input = document.createElement("input");
  input.className = "modal-input";
  input.type = "text";
  input.spellcheck = false;
  input.placeholder = "Suchen …";

  const list = document.createElement("ul");
  list.className = "modal-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Snippets");

  const error = document.createElement("p");
  error.className = "modal-error";
  error.hidden = true;

  const hint = document.createElement("p");
  hint.className = "modal-hint";
  hint.textContent =
    "Tippen filtert · ↑/↓ wählen · Enter öffnen · Esc schließen";

  let filtered = snippets;
  let selected = 0;
  let busy = false;

  const render = () => {
    list.replaceChildren();
    if (filtered.length === 0) {
      const empty = document.createElement("li");
      empty.className = "modal-empty";
      empty.textContent = snippets.length === 0
        ? "Noch keine Snippets gespeichert."
        : "Kein Treffer.";
      list.append(empty);
      return;
    }
    filtered.forEach((snippet, index) => {
      const option = document.createElement("li");
      option.className = "modal-option";
      option.setAttribute("role", "option");
      const label = document.createElement("span");
      label.textContent = `${snippet.name}.${languageExtension(snippet.language)}`;
      const meta = document.createElement("span");
      meta.className = "modal-option-meta";
      meta.textContent = languageLabel(snippet.language);
      option.append(label, meta);
      if (index === selected) {
        option.classList.add("is-selected");
        option.setAttribute("aria-selected", "true");
      }
      option.addEventListener("click", () => {
        selected = index;
        render();
        void choose();
      });
      list.append(option);
    });
  };

  const choose = async () => {
    if (busy) {
      return;
    }
    const entry = filtered[selected];
    if (!entry) {
      return;
    }
    busy = true;
    error.hidden = true;

    let snippetDocument: SnippetDocument;
    try {
      snippetDocument = await invoke<SnippetDocument>("read_snippet", {
        name: entry.name,
        language: entry.language,
      });
    } catch (failure) {
      error.textContent = String(failure);
      error.hidden = false;
      busy = false;
      return;
    }

    closeModal();
    const proceed = await guardUnsaved();
    if (!proceed) {
      busy = false;
      return;
    }
    const language = normalizeLanguage(snippetDocument.language);
    const mode =
      language === "java"
        ? "program"
        : normalizeExecutionMode(snippetDocument.mode);
    replaceDocument(
      snippetDocument.contents,
      entry.name,
      snippetDocument.contents,
      mode,
      mode,
      language,
    );
    busy = false;
  };

  const modal = openModal(null, (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (filtered.length === 0) {
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      selected = (selected + delta + filtered.length) % filtered.length;
      render();
      list
        .querySelectorAll(".modal-option")
        [selected]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void choose();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeModal();
    }
  });

  input.addEventListener("input", () => {
    const query = input.value.trim().toLowerCase();
    filtered = snippets.filter((snippet) => {
      const search = query.toLowerCase();
      return (
        snippet.name.toLowerCase().includes(search) ||
        languageLabel(snippet.language).toLowerCase().includes(search)
      );
    });
    selected = 0;
    render();
  });

  render();
  modal.append(title, input, list, error, hint);
  input.focus();
}

function focusOutput() {
  const views = outputValuesElement.querySelectorAll<HTMLElement>(".value-view");
  if (views.length > 0) {
    views[views.length - 1].focus();
  } else {
    outputElement.focus();
  }
}

function openOutputPanel(focusBanner = false) {
  if (zenHidesOutput()) {
    zenOverrides.output = true;
    applyZenLayout();
  }
  currentDockLayout.active[currentDockLayout.positions.output] = "output";
  renderDocks();
  if (focusBanner) {
    outputReturnButton.focus();
  } else {
    focusOutput();
  }
}

const breakpointsBySnippet = new Map<string, Map<number, boolean>>();
let debugActive = false;
let debugStarting = false;
let debugStopped = false;
let debugStopReason = "";
let debugStartToken = 0;
let debugSnapshotToken = 0;
let debugStopRequested = false;

function debugKey(): string {
  return `${currentLanguage}:${currentSnippetName ?? "__unbenannt__"}`;
}

function breakpointsFor(key: string): Map<number, boolean> {
  let breakpoints = breakpointsBySnippet.get(key);
  if (!breakpoints) {
    breakpoints = new Map();
    breakpointsBySnippet.set(key, breakpoints);
  }
  return breakpoints;
}

function currentBreakpoints(): Map<number, boolean> {
  return breakpointsFor(debugKey());
}

function syncBreakpointMarkers() {
  view.dispatch({
    effects: setBreakpointLinesEffect.of(new Map(currentBreakpoints())),
  });
}

function toggleBreakpointAtLine(lineNumber: number) {
  if (currentLanguage !== "rust") {
    showLspHint("Haltepunkte sind nur für Rust verfügbar.", 5000);
    return;
  }
  if (currentMode !== "program") {
    showLspHint(
      "Haltepunkte sind nur im Programmmodus verfügbar.",
      5000,
    );
    return;
  }
  const breakpoints = currentBreakpoints();
  if (breakpoints.has(lineNumber)) {
    breakpoints.delete(lineNumber);
  } else {
    breakpoints.set(lineNumber, true);
  }
  syncBreakpointMarkers();
  if (debugActive) {
    void pushBreakpoints();
  }
}

function toggleBreakpointAtCursor() {
  const line = view.state.doc.lineAt(
    view.state.selection.main.head,
  ).number;
  toggleBreakpointAtLine(line);
}

function breakpointLines(): number[] {
  return [...currentBreakpoints().keys()].sort((left, right) => left - right);
}

function updateBreakpointStates(states: DebugBreakpointState[]) {
  const breakpoints = currentBreakpoints();
  for (const state of states) {
    if (breakpoints.has(state.line)) {
      breakpoints.set(state.line, state.verified);
    }
  }
  syncBreakpointMarkers();
}

async function pushBreakpoints() {
  if (!debugActive) {
    return;
  }
  try {
    const states = await invoke<DebugBreakpointState[]>(
      "debug_set_breakpoints",
      { lines: breakpointLines() },
    );
    updateBreakpointStates(states);
  } catch (failure) {
    showLspHint(String(failure), 8000);
  }
}

function setDebugEditingLocked(locked: boolean) {
  view.dispatch({
    effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(locked)),
  });
}

function setDebugLine(line: number | null) {
  view.dispatch({ effects: setDebugLineEffect.of(line) });
}

function clearDebugLocals() {
  debugLocalsElement.replaceChildren();
}

function setDebugStatus(text: string) {
  debugStatusElement.textContent = text;
}

function showDebugView(text: string) {
  debugViewElement.hidden = false;
  setDebugStatus(text);
}

function hideDebugView() {
  debugViewElement.hidden = true;
  setDebugStatus("");
  clearDebugLocals();
  debugOutputElement.textContent = "";
  debugOutputElement.hidden = true;
}

function renderDebugLocals(variables: DebugVariable[]) {
  debugLocalsElement.replaceChildren();
  if (variables.length === 0) {
    const empty = document.createElement("div");
    empty.className = "debug-local-empty";
    empty.textContent = "Keine lokalen Variablen.";
    debugLocalsElement.append(empty);
    return;
  }
  for (const variable of variables) {
    const row = document.createElement("div");
    row.className = "debug-local";
    const name = document.createElement("span");
    name.className = "debug-local-name";
    name.textContent = variable.name;
    const kind = document.createElement("span");
    kind.className = "debug-local-type";
    kind.textContent = variable.type ?? "";
    const value = document.createElement("span");
    value.className = "debug-local-value";
    value.textContent = variable.value;
    row.append(name, kind, value);
    debugLocalsElement.append(row);
  }
}

function appendDebugOutput(text: string) {
  const next = (debugOutputElement.textContent ?? "") + text;
  debugOutputElement.textContent = next.slice(-20000);
  debugOutputElement.hidden = false;
}

function endDebugSession() {
  debugStartToken += 1;
  debugSnapshotToken += 1;
  debugActive = false;
  debugStarting = false;
  debugStopped = false;
  debugStopReason = "";
  setDebugEditingLocked(false);
  setDebugLine(null);
  hideDebugView();
  if (debugStopRequested) {
    return;
  }
  debugStopRequested = true;
  void invoke("debug_stop")
    .catch(() => {
      // The session may already have ended.
    })
    .finally(() => {
      debugStopRequested = false;
    });
}

function handleDebugEvent(event: DebugEvent) {
  if (
    (event.event === "stopped" ||
      event.event === "continued" ||
      event.event === "output") &&
    !debugActive &&
    !debugStarting
  ) {
    return;
  }
  switch (event.event) {
    case "stopped": {
      debugStarting = false;
      debugActive = true;
      debugStopped = true;
      debugStopReason = event.reason ?? "Halt";
      setDebugEditingLocked(true);
      setDebugLine(null);
      clearDebugLocals();
      showDebugView("Angehalten");
      if (event.thread_id !== null) {
        void refreshDebugSnapshot(event.thread_id);
      }
      break;
    }
    case "continued":
      debugStopped = false;
      debugSnapshotToken += 1;
      setDebugLine(null);
      clearDebugLocals();
      showDebugView("Läuft …");
      break;
    case "output":
      if (
        event.output &&
        (event.category === "stdout" || event.category === "stderr")
      ) {
        appendDebugOutput(event.output);
      }
      break;
    case "exited":
      endDebugSession();
      break;
    case "terminated":
      endDebugSession();
      break;
    default:
      break;
  }
}

async function refreshDebugSnapshot(threadId: number) {
  const token = ++debugSnapshotToken;
  try {
    const snapshot = await invoke<DebugSnapshot>("debug_snapshot", {
      threadId,
    });
    if (
      token !== debugSnapshotToken ||
      !debugActive ||
      !debugStopped
    ) {
      return;
    }
    setDebugLine(snapshot.line);
    renderDebugLocals(snapshot.variables);
    const lineText = snapshot.line ? ` bei Zeile ${snapshot.line}` : "";
    const frameText = snapshot.frame ? ` · ${snapshot.frame}` : "";
    showDebugView(
      `Angehalten${lineText} (${debugStopReason})${frameText}`,
    );
  } catch (failure) {
    if (token === debugSnapshotToken && debugActive) {
      showDebugView(`Angehalten · Variablen nicht lesbar: ${String(failure)}`);
    }
  }
}

async function startDebug() {
  if (debugStarting) {
    return;
  }
  if (currentLanguage !== "rust") {
    showLspHint("Der Debugger ist nur für Rust verfügbar.", 6000);
    return;
  }
  if (currentMode !== "program") {
    showLspHint("Debuggen ist nur im Programmmodus verfügbar.", 6000);
    return;
  }

  const token = ++debugStartToken;
  debugStarting = true;
  debugStopped = false;
  debugSnapshotToken += 1;
  setDebugEditingLocked(true);
  setDebugLine(null);
  clearDebugLocals();
  debugOutputElement.textContent = "";
  debugOutputElement.hidden = true;
  showDebugView("Debug-Build läuft …");

  const source = view.state.doc.toString();
  try {
    const result = await invoke<DebugStartResult>("debug_start", {
      source,
      snippet: currentSnippetName,
      mode: currentMode,
      breakpoints: breakpointLines(),
    });

    if (token !== debugStartToken) {
      if (result.started) {
        void invoke("debug_stop").catch(() => {});
      }
      return;
    }

    if (!result.started) {
      debugStarting = false;
      setDebugEditingLocked(false);
      hideDebugView();
      const rendered = result.diagnostics
        .map((diagnostic) => diagnostic.rendered)
        .filter((text) => text.length > 0)
        .join("\n\n");
      renderCurrentOutput(
        rendered ||
          result.message ||
          result.stderr ||
          "Debug-Build fehlgeschlagen.",
        [],
      );      if (view.state.doc.toString() === source) {
        view.dispatch(
          setDiagnostics(view.state, toEditorDiagnostics(result.diagnostics)),
        );
      }
      return;
    }

    debugStarting = false;
    debugActive = true;
    setDebugEditingLocked(true);
    updateBreakpointStates(result.breakpoints);
    if (!debugStopped) {
      showDebugView("Debug gestartet …");
    }
  } catch (failure) {
    if (token !== debugStartToken) {
      return;
    }
    debugStarting = false;
    debugActive = false;
    setDebugEditingLocked(false);
    hideDebugView();
    showLspHint(`Debugger: ${String(failure)}`, 10000);
  }
}

async function debugContinue() {
  if (debugStarting) {
    return;
  }
  if (!debugActive) {
    await startDebug();
    return;
  }
  if (!debugStopped) {
    showLspHint("Der Debugger läuft bereits.", 4000);
    return;
  }

  debugStopped = false;
  debugSnapshotToken += 1;
  setDebugLine(null);
  clearDebugLocals();
  showDebugView("Läuft …");
  try {
    await invoke("debug_resume", { command: "continue" });
  } catch (failure) {
    showDebugView(`Debug-Fehler: ${String(failure)}`);
  }
}

async function debugNext() {
  if (debugStarting) {
    return;
  }
  if (!debugActive || !debugStopped) {
    showLspHint("Der Debugger ist nicht angehalten.", 5000);
    return;
  }

  debugStopped = false;
  debugSnapshotToken += 1;
  setDebugLine(null);
  clearDebugLocals();
  showDebugView("Nächster Schritt …");
  try {
    await invoke("debug_resume", { command: "next" });
  } catch (failure) {
    showDebugView(`Debug-Fehler: ${String(failure)}`);
  }
}

function debugStop() {
  if (!debugActive && !debugStarting) {
    showLspHint("Keine aktive Debug-Sitzung.", 4000);
    return;
  }
  debugStartToken += 1;
  endDebugSession();
  showLspHint("Debug-Sitzung beendet.", 4000);
}

function debugBlocksEditing(): boolean {
  if (debugActive || debugStarting) {
    showLspHint(
      "Debug-Sitzung aktiv – bitte zuerst die Sitzung stoppen.",
      5000,
    );
    return true;
  }
  return false;
}

interface DiffRow {
  leftNo: number | null;
  left: string;
  rightNo: number | null;
  right: string;
  kind: "same" | "changed" | "left" | "right";
}

function diffLines(before: string, after: string): DiffRow[] {
  const a = before.split("\n");
  const b = after.split("\n");

  // Bei sehr großen Dateien auf einen zeilenweisen Vergleich ausweichen.
  if (a.length * b.length > 4_000_000) {
    const rows: DiffRow[] = [];
    const count = Math.max(a.length, b.length);
    for (let index = 0; index < count; index += 1) {
      const left = a[index];
      const right = b[index];
      const kind: DiffRow["kind"] =
        left === right
          ? "same"
          : left === undefined
            ? "right"
            : right === undefined
              ? "left"
              : "changed";
      rows.push({
        leftNo: left === undefined ? null : index + 1,
        left: left ?? "",
        rightNo: right === undefined ? null : index + 1,
        right: right ?? "",
        kind,
      });
    }
    return rows;
  }

  const width = b.length + 1;
  const lcs = new Int32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  const pushLeft = () => {
    rows.push({
      leftNo: i + 1,
      left: a[i],
      rightNo: null,
      right: "",
      kind: "left",
    });
    i += 1;
  };
  const pushRight = () => {
    rows.push({
      leftNo: null,
      left: "",
      rightNo: j + 1,
      right: b[j],
      kind: "right",
    });
    j += 1;
  };

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({
        leftNo: i + 1,
        left: a[i],
        rightNo: j + 1,
        right: b[j],
        kind: "same",
      });
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      pushLeft();
    } else {
      pushRight();
    }
  }
  while (i < a.length) {
    pushLeft();
  }
  while (j < b.length) {
    pushRight();
  }

  // Zusammengehörige Lösch-/Einfügeblöcke als geänderte Zeilenpaare zeigen.
  const paired: DiffRow[] = [];
  let index = 0;
  while (index < rows.length) {
    if (rows[index].kind !== "left") {
      paired.push(rows[index]);
      index += 1;
      continue;
    }
    const lefts: DiffRow[] = [];
    while (index < rows.length && rows[index].kind === "left") {
      lefts.push(rows[index]);
      index += 1;
    }
    const rights: DiffRow[] = [];
    while (index < rows.length && rows[index].kind === "right") {
      rights.push(rows[index]);
      index += 1;
    }
    const count = Math.max(lefts.length, rights.length);
    for (let step = 0; step < count; step += 1) {
      const left = lefts[step];
      const right = rights[step];
      paired.push({
        leftNo: left?.leftNo ?? null,
        left: left?.left ?? "",
        rightNo: right?.rightNo ?? null,
        right: right?.right ?? "",
        kind: left && right ? "changed" : left ? "left" : "right",
      });
    }
  }

  return paired;
}

function createDiffView(before: string, after: string): HTMLElement {
  const container = document.createElement("div");
  container.className = "run-diff";
  container.setAttribute("role", "table");
  container.setAttribute("aria-label", "Quelltextvergleich");

  for (const row of diffLines(before, after)) {
    const line = document.createElement("div");
    line.className = `diff-row is-${row.kind}`;
    line.setAttribute("role", "row");
    const leftNo = document.createElement("span");
    leftNo.className = "diff-no";
    leftNo.textContent = row.leftNo === null ? "" : String(row.leftNo);
    const leftCode = document.createElement("span");
    leftCode.className = "diff-code diff-left";
    leftCode.textContent = row.left === "" ? "\u00a0" : row.left;
    const rightNo = document.createElement("span");
    rightNo.className = "diff-no";
    rightNo.textContent = row.rightNo === null ? "" : String(row.rightNo);
    const rightCode = document.createElement("span");
    rightCode.className = "diff-code diff-right";
    rightCode.textContent = row.right === "" ? "\u00a0" : row.right;
    line.append(leftNo, leftCode, rightNo, rightCode);
    container.append(line);
  }

  return container;
}

function createRunResultView(run: RunRecord): HTMLElement {
  const container = document.createElement("div");
  container.className = "compare-result";

  const output = document.createElement("pre");
  output.className = "compare-output";
  output.textContent = renderResult(run);
  container.append(output);

  if (run.values.length > 0) {
    const values = document.createElement("div");
    values.className = "compare-values";
    run.values.forEach((value, index) => {
      const table = tableFrom(value);
      const element = table ? createTableView(table) : createTreeView(value);
      element.setAttribute("aria-label", `Vergleichswert ${index + 1}`);
      values.append(element);
    });
    container.append(values);
  }

  return container;
}

function createCompareColumn(label: string, run: RunRecord): HTMLElement {
  const column = document.createElement("section");
  column.className = "compare-column";

  const head = document.createElement("div");
  head.className = "compare-head";
  const title = document.createElement("span");
  title.className = "compare-label";
  title.textContent = label;
  const meta = document.createElement("span");
  meta.className = "compare-meta";
  meta.textContent = `${formatRunTime(run.started_at)} · ${formatRunDuration(run.duration_ms)} · ${runStatusLabel(run.status)}`;
  head.append(title, meta);

  const body = document.createElement("div");
  body.className = "compare-body";
  body.append(createRunResultView(run));

  column.append(head, body);
  return column;
}

async function openRunHistory() {
  if (currentSnippetName === null) {
    showLspHint("Nur benannte Snippets haben einen Laufverlauf.", 5000);
    return;
  }

  let runs: RunRecord[];
  try {
    runs = await invoke<RunRecord[]>("history_list", {
      name: currentSnippetName,
      language: currentLanguage,
    });
  } catch (error) {
    showErrorModal(`Laufverlauf nicht lesbar:\n${String(error)}`);
    return;
  }

  if (runs.length === 0) {
    showLspHint("Noch keine Läufe für dieses Snippet.", 5000);
    return;
  }

  const title = document.createElement("h2");
  title.className = "modal-title";
  title.textContent = `Laufverlauf · ${currentSnippetName}.${languageExtension(currentLanguage)}`;

  const hint = document.createElement("p");
  hint.className = "modal-text";
  hint.textContent =
    "↑/↓ wählen · Leertaste markiert zwei Läufe · Enter zeigt den Lauf in der Ausgabe · Esc schließt.";

  const list = document.createElement("ul");
  list.className = "history-list";
  list.tabIndex = 0;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Läufe des Snippets");

  let selected = 0;
  const marks: string[] = [];
  const rows: HTMLElement[] = [];

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const showButton = document.createElement("button");
  showButton.type = "button";
  showButton.className = "button button-primary";
  showButton.textContent = "Anzeigen";
  const compareButton = document.createElement("button");
  compareButton.type = "button";
  compareButton.className = "button";
  compareButton.textContent = "Vergleichen";
  compareButton.disabled = true;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "button button-ghost";
  closeButton.textContent = "Schließen";
  actions.append(showButton, compareButton, closeButton);

  const compareActions = document.createElement("div");
  compareActions.className = "modal-actions";
  const backButton = document.createElement("button");
  backButton.type = "button";
  backButton.className = "button button-ghost";
  backButton.textContent = "Zurück zur Liste";
  compareActions.append(backButton);

  const update = () => {
    rows.forEach((row, index) => {
      const isSelected = index === selected;
      row.classList.toggle("is-selected", isSelected);
      row.setAttribute("aria-selected", String(isSelected));
      const mark = row.querySelector<HTMLElement>(".history-mark");
      if (mark) {
        const position = marks.indexOf(runs[index].id);
        mark.textContent = position < 0 ? "" : String(position + 1);
      }
    });
    compareButton.disabled = marks.length !== 2;
  };

  runs.forEach((run, index) => {
    const row = document.createElement("li");
    row.className = "history-row";
    row.setAttribute("role", "option");
    row.id = `history-run-${index}`;

    const mark = document.createElement("span");
    mark.className = "history-mark";
    mark.setAttribute("aria-hidden", "true");
    const time = document.createElement("span");
    time.className = "history-time";
    time.textContent = formatRunTime(run.started_at);
    const duration = document.createElement("span");
    duration.className = "history-duration";
    duration.textContent = formatRunDuration(run.duration_ms);
    const status = document.createElement("span");
    status.className = `history-status is-${run.status}`;
    status.textContent = runStatusLabel(run.status);

    row.append(mark, time, duration, status);
    row.addEventListener("click", () => {
      selected = index;
      update();
    });
    list.append(row);
    rows.push(row);
  });

  list.setAttribute("aria-activedescendant", rows[0].id);

  const showSelected = () => {
    const run = runs[selected];
    if (!run) {
      return;
    }
    closeModal();
    renderHistoricalRun(run);
  };

  const toggleMark = () => {
    const run = runs[selected];
    if (!run) {
      return;
    }
    const existing = marks.indexOf(run.id);
    if (existing >= 0) {
      marks.splice(existing, 1);
    } else {
      marks.push(run.id);
      if (marks.length > 2) {
        marks.shift();
      }
    }
    update();
  };

  const listNodes = [title, hint, list, actions];
  let compareMode = false;

  const showList = () => {
    compareMode = false;
    modal.classList.remove("is-wide");
    modal.replaceChildren(...listNodes);
    list.focus();
    update();
  };

  const compareRuns = () => {
    if (marks.length !== 2) {
      return;
    }
    const marked = marks
      .map((id) => runs.find((run) => run.id === id))
      .filter((run): run is RunRecord => run !== undefined);
    if (marked.length !== 2) {
      return;
    }
    const [older, newer] = [...marked].sort(
      (left, right) => left.started_at - right.started_at,
    );

    compareMode = true;
    modal.classList.add("is-wide");

    const compareTitle = document.createElement("h2");
    compareTitle.className = "modal-title";
    compareTitle.textContent = "Läufe vergleichen";

    const diffSection = document.createElement("section");
    diffSection.className = "compare-section";
    const diffTitle = document.createElement("h3");
    diffTitle.className = "compare-title";
    diffTitle.textContent = "Quelltext";
    diffSection.append(diffTitle, createDiffView(older.source, newer.source));

    const grid = document.createElement("div");
    grid.className = "compare-grid";
    grid.append(
      createCompareColumn("Älterer Lauf", older),
      createCompareColumn("Neuerer Lauf", newer),
    );

    modal.replaceChildren(compareTitle, diffSection, grid, compareActions);
    backButton.focus();
  };

  const modal = openModal(null, (event) => {
    if (compareMode) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        showList();
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeModal();
      return;
    }

    if (document.activeElement !== list) {
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      selected = (selected + delta + runs.length) % runs.length;
      list.setAttribute("aria-activedescendant", rows[selected].id);
      update();
      rows[selected].scrollIntoView({ block: "nearest" });
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      showSelected();
      return;
    }

    if (event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      toggleMark();
    }
  });

  showButton.addEventListener("click", showSelected);
  compareButton.addEventListener("click", compareRuns);
  closeButton.addEventListener("click", () => closeModal());
  backButton.addEventListener("click", showList);

  update();
  modal.append(...listNodes);
  list.focus();
}

async function storeRun(
  name: string,
  language: SnippetLanguage,
  record: RunRecord,
  renderedText: string,
) {
  try {
    await invoke("history_save", { name, language, run: record });
  } catch (error) {
    if (historicalRun === null && currentOutput.text === renderedText) {
      const text = `${renderedText}\n\n⚠ Dieser Lauf konnte nicht im Verlauf gespeichert werden: ${String(error)}`;
      setOutput(text);
      currentOutput.text = text;
    } else {
      showLspHint(
        `Lauf nicht im Verlauf gespeichert: ${String(error)}`,
        7000,
      );
    }
  }
}

async function runSnippet() {
  if (running) {
    return;
  }
  if (debugActive || debugStarting) {
    showLspHint(
      "Debug-Sitzung aktiv – bitte zuerst die Sitzung stoppen.",
      5000,
    );
    return;
  }
  running = true;
  const startedAt = Date.now();
  const startedPerf = performance.now();
  renderCurrentOutput("Baue und führe aus …", []);

  const executedSource = view.state.doc.toString();
  const executedSnippet = currentSnippetName;
  const executedMode = currentMode;
  const executedLanguage = currentLanguage;

  try {
    const result = await invoke<SnippetResult>("run_snippet", {
      language: executedLanguage,
      source: executedSource,
      snippet: executedSnippet,
      mode: executedMode,
    });
    const durationMs = Math.max(0, Math.round(performance.now() - startedPerf));
    const renderedText = renderResult(result);
    renderCurrentOutput(renderedText, result.values);
    if (view.state.doc.toString() === executedSource) {
      view.dispatch(
        setDiagnostics(view.state, toEditorDiagnostics(result.diagnostics)),
      );
    }

    if (executedSnippet !== null) {
      await storeRun(
        executedSnippet,
        executedLanguage,
        {
          id: `${startedAt}-${Math.random().toString(36).slice(2, 10)}`,
          started_at: startedAt,
          duration_ms: durationMs,
          status: result.status,
          language: executedLanguage,
          mode: executedMode,
          source: executedSource,
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exit_code,
          diagnostics: result.diagnostics,
          values: result.values,
        },
        renderedText,
      );
    }
  } catch (error) {
    renderCurrentOutput(`Interner Fehler: ${String(error)}`, []);
  } finally {
    running = false;
  }
}

window.addEventListener(
  "keydown",
  (event) => {
    if (dockDragCandidate) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelDockDrag();
        return;
      }
    }

    if (activeModal) {
      const focusInside = activeModal.root.contains(document.activeElement);
      const switchSnippet =
        activeModal.passive &&
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        (event.key === "p" ||
          event.key === "P" ||
          event.key === "n" ||
          event.key === "N");
      if (!activeModal.passive || (focusInside && !switchSnippet)) {
        return;
      }
    }

    if (handleLeaderKey(event)) {
      return;
    }

    if (event.key === "F10") {
      event.preventDefault();
      event.stopPropagation();
      if (zenHidesMenubar()) {
        zenOverrides.menubar = true;
        applyZenLayout();
      }
      focusMenubar();
      return;
    }

    if (event.key === "F11") {
      event.preventDefault();
      event.stopPropagation();
      toggleZenMode();
      return;
    }

    if (
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      event.key === "-"
    ) {
      event.preventDefault();
      event.stopPropagation();
      zoomOut();
      return;
    }

    if (
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      event.key === "0"
    ) {
      event.preventDefault();
      event.stopPropagation();
      resetZoom();
      return;
    }

    if (
      (event.ctrlKey || event.metaKey) &&
      (event.key === "+" || event.key === "=")
    ) {
      event.preventDefault();
      event.stopPropagation();
      zoomIn();
      return;
    }

    if (view.hasFocus) {
      if (event.ctrlKey && !event.shiftKey && event.code === "Space") {
        event.preventDefault();
        event.stopPropagation();
        requestCompletions(view);
        return;
      }

      if (completionStatus(view.state) === "active") {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeCompletion(view);
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          moveCompletionSelection(event.key === "ArrowDown")(view);
          return;
        }
        if (
          event.key === "Enter" &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          acceptCompletion(view);
          return;
        }
      }
    }

    const inOutput = outputElement.contains(document.activeElement);

    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (assistantElement.contains(document.activeElement)) {
        void sendQuestion();
      } else {
        view.focus();
        void runSnippet();
      }
      return;
    }

    if (
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      (event.key === "D" || event.key === "d")
    ) {
      event.preventDefault();
      event.stopPropagation();
      void openCargoDependencies();
      return;
    }

    if (
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      (event.key === "L" || event.key === "l")
    ) {
      event.preventDefault();
      event.stopPropagation();
      toggleAssistant();
      return;
    }

    if (
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      (event.key === "T" || event.key === "t")
    ) {
      event.preventDefault();
      event.stopPropagation();
      openThemePicker();
      return;
    }

    if (
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      !event.altKey &&
      (event.key === "s" || event.key === "S")
    ) {
      event.preventDefault();
      event.stopPropagation();
      void saveCurrentSnippet();
      return;
    }

    if (
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      !event.altKey &&
      (event.key === "n" || event.key === "N")
    ) {
      event.preventDefault();
      event.stopPropagation();
      void createNewSnippet();
      return;
    }

    if (
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      !event.altKey &&
      (event.key === "p" || event.key === "P")
    ) {
      event.preventDefault();
      event.stopPropagation();
      void openSnippetSearch();
      return;
    }

    if (event.key === "F6") {
      event.preventDefault();
      event.stopPropagation();
      toggleFocus();
      return;
    }

    if (event.key === "Tab" && inOutput) {
      const views = Array.from(
        outputValuesElement.querySelectorAll<HTMLElement>(".value-view"),
      );
      if (views.length > 1) {
        const current = views.indexOf(document.activeElement as HTMLElement);
        const start =
          current === -1 ? (event.shiftKey ? views.length : -1) : current;
        const next = start + (event.shiftKey ? -1 : 1);
        if (next >= 0 && next < views.length) {
          event.preventDefault();
          event.stopPropagation();
          views[next].focus();
        }
      }
      return;
    }

    if (event.key === "F8" && inOutput) {
      if (diagnosticCount(view.state) === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      view.focus();
      nextDiagnostic(view);
    }
  },
  true,
);

document.addEventListener(
  "focusin",
  (event) => {
    if (
      leaderPending !== null &&
      event.target instanceof Node &&
      !view.dom.contains(event.target)
    ) {
      resetLeaderSequence();
    }
  },
  true,
);

document.addEventListener(
  "pointerdown",
  () => {
    if (leaderPending !== null) {
      resetLeaderSequence();
    }
  },
  true,
);

window.addEventListener("blur", () => {
  resetLeaderSequence();
  cancelDockDrag();
});

void loadProfiles();

void listen<DebugEvent>("debug-event", (event) => {
  handleDebugEvent(event.payload);
});

syncBreakpointMarkers();
updateMenuAvailability();
updateZenMenuLabel();
initDockHandlers();
renderDocks();
applyFocusDimming();

void startLsp(null, currentMode);

updateZoomUi();
void applyZoom(zoomPercent, false);
