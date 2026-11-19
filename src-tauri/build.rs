fn main() {
    tauri_build::build();

    // GTK/WebKit brauchen die Schema-Pfade der Build-Umgebung, sonst rendert die
    // Oberfläche ohne Styles. Die Pfade werden nur übernommen, wenn sie beim
    // Start nicht bereits gesetzt sind (siehe run()).
    for (name, key) in [
        ("XDG_DATA_DIRS", "KRITZELWERK_XDG_DATA_DIRS"),
        ("GDK_PIXBUF_MODULE_FILE", "KRITZELWERK_GDK_PIXBUF_MODULE_FILE"),
    ] {
        if let Ok(value) = std::env::var(name) {
            let value = value.trim();
            if !value.is_empty() {
                println!("cargo:rustc-env={key}={value}");
            }
        }
        println!("cargo:rerun-if-env-changed={name}");
    }
}
