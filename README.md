# Kritzelwerk

Rust-Snippets schreiben und ausführen – Tauri-2-App mit CodeMirror-6-Editor (Vanilla TypeScript + Vite).

## Entwicklung

```bash
nix develop -c npm ci
nix develop -c npm run tauri dev
```

Die Nix-Dev-Shell stellt neben Rust und rust-analyzer auch LLDB mit `lldb-dap` für den Debugger, OpenJDK 21 für Java sowie Node.js für JavaScript bereit.

Release-Binary ohne Bundle bauen:

```bash
./deploy.sh              # erzeugt ./kritzelwerk (Starter) und ./kritzelwerk.bin
./deploy.sh ~/bin        # legt beides in ~/bin ab
./kritzelwerk            # startet die App
```

Das entspricht `nix develop -c npm run tauri build -- --no-bundle`. Der Starter setzt die GTK-/GSettings-Pfade aus der Dev-Shell; zusätzlich ergänzt die App fehlende GTK-Pfade beim Start selbst, sodass auch `src-tauri/target/release/kritzelwerk` direkt funktioniert. Wichtig: innerhalb von `nix develop` bauen (z. B. über `deploy.sh`), damit die Pfade eingebettet werden.

## Bedienung

Der Editor startet im Vim-Normal-Modus; die Modusanzeige steht unten im Editor. `i` wechselt in den Insert-Modus, `Esc` zurück in den Normal-Modus.

- `Strg+Enter`: Aktuelles Snippet kompilieren und ausführen (Fokus bleibt im Editor)
- `Strg+S`: Snippet speichern
- `Strg+Umschalt+D`: Cargo-Abhängigkeiten des aktuellen Snippets verwalten
- `Strg+N`: neues Rust-Snippet
- `Strg+P`: Snippet-Suche
- `Strg+Umschalt+T`: Theme-Auswahl
- `Strg+Umschalt+L`: KI-Panel öffnen und fokussieren
- `Strg+Leertaste`: Rust-Vorschläge (Vim-Insert-Modus)
- `F10`: Menüleiste fokussieren
- `F11`: Zen-Modus umschalten
- `Strg++` / `Strg+-`: Zoom vergrößern/verkleinern
- `Strg+0`: Zoom zurücksetzen
- `F6`: Ausgabe fokussieren bzw. zurück in den Editor wechseln
- `F8`: Zur nächsten markierten Compilerdiagnose springen

Den Ausführungsmodus wechselst du über **Ausführen → Ausführungsmodus …**; die Auswahl im Dialog funktioniert mit `↑`/`↓`, `Enter` und `Esc`. Die Leader-Belegungen bearbeitest du unter **Bearbeiten → Leader-Belegungen …**.

## Leader-Taste und Which-Key

Im Vim-Normal- und Visual-Modus startet die Leader-Taste eine Tastenfolge. Nach etwa 250 ms erscheint unten im Fenster eine Übersicht der möglichen nächsten Tasten; nach einem gültigen Präfix wird sie sofort aktualisiert. Eine schnell getippte vollständige Folge wird direkt ausgeführt. `Esc`, eine ungültige Folgetaste oder ein Fokuswechsel schließen die Hilfe und verwerfen die Folge.

Standard-Leader ist die **Leertaste**:

| Folge | Aktion |
|---|---|
| `Leertaste f f` | Snippet suchen und öffnen |
| `Leertaste f n` | Neues Snippet |
| `Leertaste f s` | Snippet speichern |
| `Leertaste r` | Snippet ausführen |
| `Leertaste a` | KI-Panel öffnen und fokussieren |
| `Leertaste t` | Theme-Auswahl öffnen |
| `Leertaste ?` | Tastenkürzel-Übersicht öffnen |
| `Leertaste d b` | Haltepunkt auf der aktuellen Zeile setzen/entfernen |
| `Leertaste d c` | Debugger starten oder bis zum nächsten Halt weiterlaufen |
| `Leertaste d n` | Einen Schritt weitergehen |
| `Leertaste d q` | Debug-Sitzung stoppen |
| `Leertaste z` | Zen-Modus umschalten |

Im Visual-Modus zeigt die Hilfe nur die aktuell belegte KI-Aktion; beim Ausführen wird die Auswahl als Code-Anhang in die Seitenleiste übernommen. Im Insert-Modus bleibt die Leader-Taste eine normale Texteingabe.

Unter **Bearbeiten → Leader-Belegungen …** lassen sich der Leader und die Folgen ändern. Der Leader ist die Leertaste oder ein einzelnes druckbares Zeichen. Folgen bestehen aus ein bis drei Zeichen und werden als `r` oder mit Leerzeichen getrennt wie `x r` eingegeben. Doppelte Folgen und Präfixkonflikte (z. B. `x` und `x r`) werden direkt am betroffenen Feld angezeigt; die bisherige Belegung bleibt aktiv, bis gültige Eingaben mit **Übernehmen** gespeichert sind. **Abbrechen** verwirft die Dialogänderungen, **Standards wiederherstellen** setzt die Standardbelegung sofort wieder in Kraft. Die Konfiguration wird lokal gespeichert und gilt nach einem Neustart weiter. **Hilfe → Tastenkürzel** liest dieselbe aktive Konfiguration.

## Strukturierte Werte mit `dump()`

```rust
use scratchpad::dump;

dump(&wert);
```

`dump()` serialisiert den Wert als JSON-Zeile; pro Aufruf erscheint ein Ergebnis in der Ausgabe. Listen gleichartiger Objekte werden als Tabelle dargestellt, Objekte und andere Listen als aufklappbarer Baum; verschachtelte Tabellenzellen lassen sich mit `Enter` aufklappen. Normale `println!`-Ausgabe und Compilerdiagnosen bleiben als Text sichtbar.

Navigation in der Ausgabe: `F6` wechselt in die Ausgabe, `Tab` wechselt zwischen Tabelle und Baum. In der Tabelle bewegen die Pfeiltasten die aktive Zelle. Im Baum wählen `↑`/`↓` sichtbare Einträge, `→` öffnet und `←` schließt sie.

## Laufverlauf und Vergleich

**Ausführen → Laufverlauf …** zeigt die letzten zehn abgeschlossenen Läufe des aktuellen benannten Snippets, neueste zuerst, mit Uhrzeit, Dauer und Status (Erfolg, Build-Fehler, Laufzeitfehler, Zeitüberschreitung). Unbenannte Snippets haben keinen Verlauf.

Jeder Lauf speichert den tatsächlich ausgeführten Quelltext inklusive ungespeicherter Änderungen, Sprache, Ausführungsmodus, Startzeit, Dauer, Status, Textausgabe, Diagnosen und `dump()`-Werte unter `${XDG_DATA_HOME}/kritzelwerk/history/<sprache>/<name>.json` (sonst `~/.local/share/…`). Gleichnamige Rust-, Java- und JavaScript-Snippets haben getrennte Verläufe. Wird während eines Laufs ein anderes Snippet geöffnet, gehört das Ergebnis weiterhin zum ursprünglichen Snippet.

- `↑`/`↓` wählt einen Lauf, `Enter` zeigt ihn im Ausgabepanel. Dort ist er als **Historischer Lauf** mit Zeit, Dauer und Status gekennzeichnet; **Zur aktuellen Ausgabe** stellt das zuletzt angezeigte Ergebnis wieder her. Das Panel öffnet sich an seiner angedockten Position, auch im Zen-Modus.
- Historische Ergebnisse nutzen dieselben Text-, Tabellen- und Baumansichten. Diagnosen bleiben als Text lesbar, setzen aber keine Markierungen im aktuellen Editor. Editorinhalt, Cursor und ungespeicherte Änderungen bleiben unverändert.
- `Leertaste` markiert in der Liste zwei Läufe; **Vergleichen** öffnet einen Zeilendiff des Quelltexts und stellt beide Ergebnisse mit ihren `dump()`-Werten gegenüber. Die Spalten sind als **Älterer Lauf** und **Neuerer Lauf** beschriftet. `Esc` führt zurück zur Liste, ein weiteres `Esc` schließt sie.
- Schlägt das Speichern fehl, bleibt das aktuelle Ergebnis sichtbar und ein Hinweis nennt den Fehler.

## Menüleiste und Zoom

Die Menüleiste oben enthält **Datei**, **Bearbeiten**, **Ansicht**, **Ausführen** und **Hilfe**; die Einträge rufen dieselben Aktionen wie die Tastenkürzel auf. Unter **Hilfe** findest du die Tastenkürzel-Übersicht und „Über Kritzelwerk“ mit der aktuellen Version.

`F10` fokussiert die Menüleiste. `←`/`→` wechseln zwischen den Menüs, `↓` öffnet das gewählte Menü, `↑`/`↓` navigieren darin, `Enter` aktiviert den Eintrag. `Esc` schließt das Menü und gibt den Fokus an den zuvor aktiven Bereich zurück.

Der Zoom lässt sich über die Buttons `−`, `100 %` und `+` rechts in der Leiste, über das Menü **Ansicht** oder per `Strg++`, `Strg+-` und `Strg+0` ändern. Der Bereich liegt zwischen 80 % und 200 % in 10-%-Schritten; die Prozentzahl setzt auf 100 % zurück. Der zuletzt erfolgreich angewendete Wert wird lokal gespeichert und beim Start wiederhergestellt. Menüleiste, Editor, Ausgabe, Dialoge und KI-Panel skalieren gemeinsam.

## Snippets

Snippets liegen als `.rs`-, `.java`- und `.mjs`-Dateien unter:

- `${XDG_DATA_HOME}/kritzelwerk/snippets/`
- sonst `~/.local/share/kritzelwerk/snippets/`

- `Strg+S`: aktuelles Snippet speichern. Beim ersten Speichern fragt ein Namensfeld nach dem Namen (`Enter` bestätigt, `Esc` bricht ab).
- `Strg+N`: neues Rust-Snippet mit Ausdrucks-Gerüst.
- **Datei → Neues Java-Snippet**: neues Java-Snippet im Programmmodus.
- **Datei → Neues JavaScript-Snippet**: neues JavaScript-Snippet im Programmmodus.
- `Strg+P`: Snippet-Suche über Rust, Java und JavaScript; Tippen filtert, `↑`/`↓` wählen, `Enter` öffnet, `Esc` schließt. Jeder Eintrag zeigt seine Sprache; gleiche Anzeigenamen sind als `.rs`, `.java` und `.mjs` getrennt auswählbar.

Die aktive Sprache steht neben dem Snippet-Namen. Rust, Java und JavaScript verwenden getrennte Dateien und Metadaten; vorhandene Rust-Snippets, Modi und Cargo-Abhängigkeiten bleiben unverändert.

In der Kopfzeile stehen der Snippet-Name und ein `*` für ungespeicherte Änderungen. Beim Öffnen oder Anlegen mit ungespeicherten Änderungen erscheint ein Dialog mit **Speichern**, **Verwerfen** und **Abbrechen**; ein vorhandener Name wird nie still überschrieben.

Der Ausführungsmodus wird neben dem Snippet-Namen angezeigt und unter `${XDG_DATA_HOME}/kritzelwerk/snippets/<name>.json` gespeichert (sonst `~/.local/share/kritzelwerk/snippets/<name>.json`). Ein Moduswechsel markiert das Snippet als ungespeichert; Speichern, Verwerfen und Abbrechen laufen wie bei einer Textänderung. Der Editorinhalt, Cursor, Vim-Modus und Undo-Verlauf bleiben beim Wechsel unverändert.

## Ausführungsmodi

Neue Snippets starten als **Ausdruck**. Bestehende `.rs`-Dateien ohne gespeicherten Modus werden als **Programm** geöffnet.

### Ausdruck

Der Editorinhalt ist ein einzelner Rust-Ausdruck. Kritzelwerk wertet ihn aus und zeigt das Ergebnis automatisch über `dump()` an.

```rust
[1, 2, 3].iter().sum::<i32>()
```

Die Ausgabe zeigt `6`. Auch strukturierte Werte funktionieren:

```rust
vec!["Eisen", "Kupfer"]
```

Der Wert muss `serde::Serialize` implementieren. Für Typen mit nur `Debug` nutze den Modus **Anweisungen** und `println!("{wert:?}")`:

```rust
let wert = vec!["Eisen", "Kupfer"];
println!("{wert:?}");
```

### Anweisungen

Der Editorinhalt wird in ein generiertes `fn main()` gesetzt. `println!` und manuelle `dump()`-Aufrufe funktionieren wie gewohnt.

```rust
let menge = 3;
println!("{menge}");
```

### Programm

Der Editorinhalt ist ein vollständiges Rust-Programm und wird unverändert ausgeführt.

```rust
fn main() {
    println!("Hallo, Kritzelwerk!");
}
```

Der generierte Wrapper-Code existiert nur im Arbeitsverzeichnis des Runners; die gespeicherte `.rs`-Datei enthält weiterhin genau den Editorinhalt. Compilerdiagnosen aus dem Wrapper werden auf die Byte-Positionen im Editor zurückgerechnet und als UTF-16-Bereiche markiert. Meldungen ohne zuordenbare Stelle erscheinen vollständig in der Ausgabe.

## Cargo-Abhängigkeiten

`Strg+Umschalt+D` (oder **Datei → Cargo-Abhängigkeiten …**) öffnet die Abhängigkeiten des aktuellen Snippets. Bei einem unbenannten Snippet fragt die App zuerst nach einem Namen. Pro Zeile werden Crate-Name, Versionsanforderung und optionale Features erfasst; `Tab` wechselt die Felder, `Strg+Enter` übernimmt, `Esc` bricht ab.

**Übernehmen** löst die Angaben zuerst in einem temporären Cargo-Projekt auf. Erst wenn Cargo erfolgreich ein Lockfile erzeugt hat, werden Abhängigkeiten und `Cargo.lock` übernommen. Schlägt die Auflösung fehl (z. B. unbekannte Crate, keine passende Version, kein Netz), bleibt die zuletzt funktionierende Konfiguration aktiv und der Fehler steht im Dialog. Die Auflösung läuft im Hintergrund; der Dialog blockiert den Editor nicht. Du kannst weiterarbeiten oder ein anderes Snippet öffnen – das Ergebnis wird immer beim ursprünglichen Snippet gespeichert. Nach erfolgreicher Änderung wird das rust-analyzer-Projekt neu aufgebaut.

Beispiel:

1. Snippet speichern, z. B. als `regex-test`.
2. `Strg+Umschalt+D`, eine Zeile mit Crate `regex`, Version `1` und ohne Features eintragen, `Strg+Enter`.
3. Ausführen:

```rust
fn main() {
    let treffer = regex::Regex::new(r"\d+").unwrap().is_match("Erz 42");
    println!("{treffer}");
}
```

Die Ausgabe ist `true`. Anschließend bietet `Strg+Leertaste` im Insert-Modus auch `regex`-Symbole an. Ein anderes Snippet ohne `regex`-Eintrag kennt die Bibliothek weder beim Kompilieren noch in den Vorschlägen.

Gespeichert wird pro Snippet unter:

- `${XDG_DATA_HOME}/kritzelwerk/dependencies/<name>/`
- sonst `~/.local/share/kritzelwerk/dependencies/<name>/`

Dort liegen `dependencies.json` und `Cargo.lock`. Snippets ohne diese Metadaten laufen unverändert weiter. Läufe mit gespeichertem Lockfile verwenden `cargo build --locked`, damit `Strg+Enter` die aufgelösten Versionen nicht nebenbei ändert. Die Analyse für rust-analyzer entsteht aus derselben Konfiguration samt Lockfile in einem getrennten Arbeitsverzeichnis.

## Teilen, Importieren und Cargo-Export

Unter **Datei** stehen drei Export-/Import-Aktionen bereit:

- **Snippet exportieren …** schreibt eine versionierte `.kritzelwerk.json`-Datei mit Anzeigename, aktuellem Editorinhalt, Ausführungsmodus, Cargo-Abhängigkeiten und – falls vorhanden – `Cargo.lock`. Der aktuelle Speicherzustand wird nicht verändert. Die Datei ist zum Teilen zwischen Kritzelwerk-Installationen gedacht.
- **Snippet importieren …** zeigt vor dem Übernehmen Name, Modus, Abhängigkeiten und Lockfile an. Bei einem Namenskonflikt lässt sich ein neuer Name eingeben. Ungültige Dateien und unbekannte Formatversionen werden mit einer Fehlermeldung abgelehnt. Beim Import wird kein Code ausgeführt und Cargo nicht gestartet; das Snippet erscheint anschließend in der Sammlung und ist über `Strg+P` erreichbar. Liegen ungespeicherte Änderungen vor, erscheint der übliche Speichern-/Verwerfen-/Abbrechen-Dialog.
- **Als Cargo-Projekt exportieren …** erzeugt im Zielordner `Cargo.toml`, `src/main.rs`, die `scratchpad`-Bibliothek als `src/lib.rs`, eine `README.md` und – sofern passend – `Cargo.lock`. Vorhandene Dateien werden nicht überschrieben; der Zielordner muss neu oder leer sein. Der gespeicherte Ausführungsmodus wird angewendet, sodass auch ein einzelner Ausdruck als vollständiges Programm startet.

Die exportierte README nennt den Startbefehl: `cargo run --locked` bei übernommenem Lockfile, sonst `cargo run`. In einem eigenständigen Lauf gibt `dump()` formatiertes JSON auf stdout aus; innerhalb von Kritzelwerk bleibt die strukturierte Ergebnisansicht erhalten.

Beide Formate enthalten ausschließlich Daten des gewählten Snippets. KI-Profile, Serveradressen, API-Schlüssel und andere App-Einstellungen werden nicht exportiert.

## Debuggen

Das Debuggen ist im **Programmmodus** verfügbar. Haltepunkte setzt du mit `Leertaste d b` oder per Klick links neben die Zeilennummer; sie erscheinen als Punkt neben dem Editor. Kann LLDB einen Haltepunkt nicht bestätigen, wird er als offener Kreis dargestellt. Die aktuellen Debug-Aktionen stehen auch unter **Ausführen** und in der Leader-Belegung.

`Leertaste d c` baut das Snippet im Debug-Profil (`cargo build --profile dev`, ohne Optimierung, mit Symbolen), verwendet das von Cargo gemeldete Binärprogramm und startet `lldb-dap` über das Debug Adapter Protocol. Abhängigkeiten und ein vorhandenes `Cargo.lock` werden wie beim normalen Lauf verwendet. Bei einem Build-Fehler startet keine Sitzung; die Compilerdiagnosen erscheinen wie gewohnt und sind mit `F8` erreichbar.

Während einer Sitzung bleibt der ausgeführte Quelltext im Editor sichtbar und schreibgeschützt. Die Debug-Ansicht unter dem Editor zeigt den Sitzungsstatus, die aktuelle Zeile und die lokalen Variablen des obersten Stackframes mit Name, Typ und Wert. `Leertaste d n` führt einen Schritt aus, `Leertaste d c` läuft bis zum nächsten Haltepunkt weiter, `Leertaste d q` beendet Debugger und Programm. Beim Stoppen oder Beenden der App werden lldb-dap und der gestartete Prozess beendet; das normale Fünf-Sekunden-Limit gilt für Debug-Sitzungen nicht. Nach dem Stoppen ist der Editor wieder editierbar.

## Java

Java-Snippets werden über **Datei → Neues Java-Snippet** angelegt und als `.java` gespeichert. Die Nix-Dev-Shell stellt OpenJDK 21 bereit; ohne verfügbares JDK erscheint eine verständliche Fehlermeldung.

Unterstützt wird der Programmmodus mit einer UTF-8-Quelldatei ohne `package`, die eine `public class Main` mit `public static void main(String[] args)` enthält. Der Anzeigename des Snippets darf vom Klassennamen abweichen.

```java
import java.util.List;

public class Main {
    public static void main(String[] args) {
        var funde = List.of(0, 3, 0, 7).stream()
            .filter(menge -> menge > 0)
            .toList();
        System.out.println(funde);
    }
}
```

`Strg+Enter` kompiliert über die JDK-Compiler-API (`javax.tools.JavaCompiler` mit `DiagnosticCollector`) und startet anschließend `Main` im frisch erzeugten Klassenverzeichnis. Compilerdiagnosen werden als UTF-16-Bereiche im Editor markiert und sind mit `F8` erreichbar. Die Programmausführung unterliegt dem normalen Fünf-Sekunden-Limit.

Für Java stehen Cargo-Abhängigkeiten, rust-analyzer-Vervollständigung, Rust-Debugging, `dump()`, der Snippet-Export und der Cargo-Projekt-Export nicht zur Verfügung; die entsprechenden Menüeinträge werden ausgeblendet. Rust-, Java- und JavaScript-Snippets lassen sich über dieselbe Suche öffnen und getrennt speichern.

## JavaScript

JavaScript-Snippets werden über **Datei → Neues JavaScript-Snippet** angelegt und als `.mjs` gespeichert. Sie laufen mit dem Node.js aus der Nix-Dev-Shell; fehlt Node.js, erscheint eine verständliche Fehlermeldung. Unterstützt werden ES-Module, Importe aus der Node-Standardbibliothek und `await` auf Modulebene.

```javascript
const funde = [0, 3, 0, 7].filter(menge => menge > 0);
console.log(JSON.stringify(funde));
```

Top-Level-`await` und Node-Importe:

```javascript
import { setTimeout as sleep } from "node:timers/promises";

await sleep(10);
console.log("await ok");
```

Vor dem Start prüft `node --check` die Datei. Syntaxfehler werden mit der vollständigen Node-Meldung und einer Zeilenmarkierung im Editor angezeigt; bei Laufzeitfehlern wird die erste Stacktrace-Position im aktuellen `snippet.mjs` verwendet. `F8` springt zur markierten Stelle. Die Ausführung unterliegt dem normalen Fünf-Sekunden-Limit.

Npm-Abhängigkeiten, JavaScript-Autovervollständigung, Debugging und `dump()` für JavaScript werden noch nicht unterstützt. Die entsprechenden Rust-/Java-spezifischen Menüeinträge und Leader-Aktionen werden für JavaScript ausgeblendet.

## Panels andocken und skalieren

Ausgabe und KI sind andockbare Panels um den Editor herum. Standardmäßig liegt die Ausgabe unten und die KI rechts; der Editor bleibt in der Mitte.

- **Maus:** Panel an der Tab-/Kopfzeile ziehen. Während des Ziehens erscheinen die Ziele **Links**, **Rechts** und **Unten**, das aktuelle Ziel ist hervorgehoben. Loslassen auf einem Ziel dockt an; `Esc` oder Loslassen außerhalb der Ziele bricht ab.
- **Tastatur:** **Ansicht → Ausgabe andocken …** bzw. **Ansicht → KI andocken …** (`F10`, dann mit den Pfeiltasten und `Enter` bedienen). Im Dialog wählen `↑`/`↓` die Seite, `Enter` übernimmt, `Esc` schließt.
- Liegen beide Panels an derselben Seite, erscheinen sie als Tabs mit beiden Einträgen; das verschobene Panel wird dabei der aktive Tab.
- Der Größenregler zwischen Panel und Editor lässt sich mit der Maus ziehen. Nach dem Fokussieren (Klick oder `Tab`) skalieren die Pfeiltasten in Richtung Vergrößern/Verkleinern, mit `Shift` in größeren Schritten. Die Größe ist so begrenzt, dass der Editor auch bei schmalem Fenster oder erhöhtem Zoom bedienbar bleibt.
- `F6` aktiviert und fokussiert die Ausgabe unabhängig von ihrer Seite; `Strg+Umschalt+L` öffnet bzw. fokussiert die KI. Liegen beide im selben Dock, wechseln die Kürzel zum passenden Tab.
- Positionen, Dock-Größen und aktive Tabs werden lokal unter `kritzelwerk.docks` gespeichert und beim Start wiederhergestellt. **Ansicht → Standardlayout wiederherstellen** setzt Ausgabe unten, KI rechts und die Standardgrößen zurück.
- Beim Verschieben bleiben die vorhandenen Panels erhalten: Tabellen und aufgeklappte Baumknoten der Ausgabe, KI-Eingaben und -Antworten sowie Editorzustand, Cursor, Undo-Verlauf und Vim-Modus.

## Zen-Modus

`F11` oder **Ansicht → Zen-Modus umschalten** schaltet den Zen-Modus ein und aus. Das Menü zeigt im aktiven Zustand **✓ Zen-Modus beenden**. Die Leader-Folge `Leertaste z` schaltet ebenfalls um; bei einem Konflikt mit einer Benutzerbelegung bleibt die Benutzerbelegung aktiv, die Aktion ist weiterhin im Menü und in der Belegungsliste verfügbar.

Unter **Ansicht → Zen-Modus konfigurieren …** lassen sich Menüleiste samt Zoom, Snippet-Kopfleiste, Ausgabe samt Debug-Ansicht, KI-Seitenleiste und Vim-Status ein- oder ausblenden. Standardmäßig bleibt nur der Vim-Status sichtbar; der Editor ist immer sichtbar. Für den Editor stehen **Volle Breite** und **Zentriert** zur Wahl; die zentrierte Fläche ist auf etwa 100 Zeichen begrenzt und passt sich schmalen Fenstern an.

Für die **Fokus-Abdunklung** stehen **Aus**, **Nur in Zen** (Standard) und **Immer** zur Wahl. **Kontextzeilen je Seite** legen fest, wie viele logische Quellzeilen oberhalb und unterhalb der Cursorzeile normal lesbar bleiben (Standard: 5; bei 0 nur die Cursorzeile). Die **Stärke** reicht von 0 bis 80 % (Standard: 50 %); bei 0 % bleibt der Text unverändert. Die Abdunklung folgt Cursor- und Vim-Sprüngen, `F8`, Scrollen, Textänderungen und Snippetwechseln. Umgebrochene Bildschirmzeilen gehören zur jeweiligen Quellzeile. Cursor, Auswahl, Diagnosemarkierungen und Haltepunkte bleiben sichtbar.

Die Einstellungen werden lokal unter `kritzelwerk.zen` gespeichert. Nach einem Neustart startet Kritzelwerk in der normalen Ansicht; beim nächsten Einschalten verwendet Zen die gespeicherten Einstellungen. Ältere gespeicherte Einstellungen werden um fehlende Werte ergänzt, ohne Breite oder Sichtbarkeit der Bereiche zu verändern. Die Panels folgen beim Umschalten den Zen-Einstellungen und erscheinen beim Verlassen wieder an ihrer gespeicherten Dock-Seite mit der vorherigen Größe. Text, Cursor, Vim-Modus, Undo-Verlauf, Ausgaben und KI-Antworten bleiben erhalten.

`Strg+Enter` arbeitet auch bei ausgeblendeter Ausgabe. `F6` blendet die Ausgabe für die laufende Zen-Sitzung an ihrer gespeicherten Seite ein und fokussiert sie; `F10` zeigt eine ausgeblendete Menüleiste zur Bedienung. Das KI-Kürzel blendet das KI-Panel bei Bedarf an seiner Dock-Seite ein. Diese temporären Einblendungen ändern weder die Zen-Einstellungen noch das gespeicherte Dock-Layout. `Esc`, Dialoge, Which-Key und Compilerdiagnosen behalten ihre bisherige Funktion.

## Themes

`Strg+Umschalt+T` öffnet die Theme-Auswahl; `↑`/`↓` wählen, `Enter` übernimmt, `Esc` schließt. Verfügbar sind **Catppuccin Mocha** (Standard) und **Catppuccin Latte**. Die Auswahl wird lokal gespeichert und beim nächsten Start wiederhergestellt; der Editor behält beim Wechsel Quelltext, Cursor, Vim-Modus und Undo-Verlauf.

## Autovervollständigung

Im Vim-Insert-Modus öffnet `Strg+Leertaste` die Rust-Vorschläge. `↑`/`↓` wählen, `Enter` übernimmt; das erste `Esc` schließt nur die Liste, das nächste wechselt wie gewohnt in den Normal-Modus. Die Vorschläge stammen von `rust-analyzer` und berücksichtigen den aktuellen, auch ungespeicherten Editorinhalt.

- Der Sprachserver läuft über das Rust-Backend (stdin/stdout) und wird beim Beenden der App aufgeräumt.
- Die rust-analyzer-Vervollständigung ist im **Programm**-Modus von Rust verfügbar. In Rust-**Ausdruck** und **Anweisungen** sowie für Java und JavaScript zeigt `Strg+Leertaste` einen Hinweis, dass die Vervollständigung dort noch aussteht.
- Das Analyseprojekt liegt getrennt vom Snippet-Runner unter `${XDG_CACHE_HOME:-~/.cache}/kritzelwerk/rust-analysis` und nutzt dieselbe Edition, Abhängigkeiten und `scratchpad`-Bibliothek.
- Die Nix-Dev-Shell stellt `rust-analyzer` sowie die Standardbibliotheksquellen bereit (`rustPlatform.rustLibSrc`, exportiert als `RUST_SRC_PATH`).
- Automatische Vorschläge beim Tippen, Hover-Dokumentation und „Gehe zu Definition“ sind nicht aktiv; Inline-Diagnosen kommen weiterhin aus dem Cargo-Lauf.

## KI-Seitenleiste

`Strg+Umschalt+L` öffnet und fokussiert das KI-Panel an seiner Dock-Position. Die Seitenleiste enthält Frage, Ladezustand und Antwort; Quelle, Modell und Zieladresse stehen unter **Bearbeiten → Einstellungen** im Bereich **KI**.

Jede Anfrage enthält den vollständigen aktuellen Editorinhalt, auch ungespeicherte Änderungen, sowie die Sprache des Snippets. Wird im Vim-Visual-Modus Code markiert und anschließend die Seitenleiste geöffnet, kommen die vollständigen markierten Quellzeilen mit Start- und Endzeile hinzu. Die Auswahl wird verworfen, sobald ein anderes Snippet aktiv ist oder sich der Text seit der Erfassung geändert hat; der Code stammt immer aus dem zum Absendezeitpunkt aktiven Snippet. Die Frage wird mit `Strg+Enter` abgeschickt; im Editor führt `Strg+Enter` weiterhin das Snippet aus.

Der Aufbau ist für alle Anbieter gleich: **Frage**, **Vollständiger Code** und optional **Markierte Zeilen**. Lehnt ein Anbieter den Kontext ab, etwa wegen des Kontextfensters, erscheint eine verständliche Fehlermeldung im Statusbereich.

### KI-Einstellungen

Unter **Bearbeiten → Einstellungen** im Bereich **KI** werden Quelle und Modell-ID gewählt; die Zieladresse wird dort angezeigt. Öffentliche Vorlagen sind **Ollama** (`http://127.0.0.1:11434/v1`), **Strata** (`http://127.0.0.1:8080/v1`) und **OpenAI** (`https://api.openai.com/v1`); persönliche Profile erscheinen zusätzlich, wenn die Backend-Konfiguration existiert. Quelle und Modell werden lokal unter `kritzelwerk.ai` gespeichert und beim Start wiederhergestellt.

Der Dialog erklärt, dass beim Absenden der vollständige Editorinhalt an die gewählte Quelle übertragen wird. Das Öffnen der Seitenleiste und das Markieren von Code lösen keine Anfrage aus. Zugangsdaten und persönliche Profile folgen weiterhin der Backend-Konfiguration; ohne gültige Quelle oder Modell-ID bietet die Seitenleiste einen direkten Zugang zu den Einstellungen. Bei fehlender Modell-ID, fehlenden Zugangsdaten, nicht erreichbarem Server oder Zeitüberschreitung erscheint eine Fehlermeldung; die gespeicherte Konfiguration bleibt aktiv.

### Persönliches Gateway

Ein persönliches Gateway wird nur angezeigt, wenn die lokale Konfigurationsdatei existiert:

- `${XDG_CONFIG_HOME}/kritzelwerk/profiles.json`
- sonst `~/.config/kritzelwerk/profiles.json`

Format (Platzhalter):

```json
{
  "profiles": [
    {
      "id": "mein-gateway",
      "name": "Mein Gateway",
      "protocol": "openai",
      "base_url": "https://gateway.example/v1",
      "model": "mein-modell",
      "api_key_env": "MEIN_GATEWAY_KEY"
    }
  ]
}
```

- `protocol`: `openai` (OpenAI-kompatible Chat-Completions-API) oder `cloud-data` (cloud-data-Acquisitions-API).
- Bei `protocol: "cloud-data"` ist `model` die Modellroute, z. B. `ollama`, `ollama:mein-host` oder `openai:mein-host`; `base_url` zeigt auf die cloud-data-API.
- `api_key_env` ist optional; wenn angegeben, muss die Variable gesetzt sein, sonst erscheint ein Fehler.
- Persönliche Profile erscheinen in den KI-Einstellungen als „persönlich“, da sie an lokale oder Cloud-Modelle weiterleiten können. Modellroute und Modell-ID werden weiterhin über die Einstellungen gewählt.

## Prüfungen

```bash
nix develop -c npm run build
nix develop -c cargo check --manifest-path src-tauri/Cargo.toml
```
